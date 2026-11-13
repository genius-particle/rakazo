import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type {
  Adapter,
  AdapterPostableMessage,
  FormattedContent,
  WebhookOptions,
} from "chat";
import { NotImplementedError, stringifyMarkdown } from "chat";
import type { GrokbotAskStore } from "./ask-store.js";

/**
 * The advisor channel: a plain HTTP webhook pair with no vendor SDK. Outbound
 * questions POST to the advisor's routine webhook (大娃 on another Rakazo
 * deployment); the advisor's routine POSTs the reply back to this deployment's
 * `/api/v1/messaging/webhook/grokbot` with the inbound bearer. Replies resolve
 * pending `ask_grokbot` calls through the ask store, and nothing here creates
 * messaging runs — so the channel cannot echo, loop, or fan out on its own.
 */

export const GROKBOT_PROVIDER = "grokbot";

/** Bounds one outbound POST so a hung advisor cannot stall the send caller. */
export const GROKBOT_SEND_TIMEOUT_MS = 10_000;

/** Inbound webhook bodies larger than this are rejected before parsing. */
const MAX_BODY_BYTES = 256 * 1024;

/** Every correlation id the tool mints starts with this marker. */
export const GROKBOT_CORRELATION_PREFIX = "re-";

/** The adapter's native thread ids: "grokbot:<peerAddress>". */
export interface GrokbotThreadId {
  peer: string;
}

const THREAD_PREFIX = "grokbot:";

export function encodeGrokbotThreadId({ peer }: GrokbotThreadId): string {
  if (!peer) throw new Error("Invalid advisor thread: empty peer address");
  return `${THREAD_PREFIX}${peer}`;
}

export function decodeGrokbotThreadId(threadId: string): GrokbotThreadId {
  if (!threadId.startsWith(THREAD_PREFIX)) {
    throw new Error(`Invalid advisor thread ID: ${threadId}`);
  }
  const peer = threadId.slice(THREAD_PREFIX.length);
  if (!peer) throw new Error(`Invalid advisor thread ID: ${threadId}`);
  return { peer };
}

export interface GrokbotAdapterConfig {
  /** The advisor's routine webhook URL (POST target for questions). */
  outboundUrl: string;
  /** Bearer presented on outbound POSTs to the advisor. */
  outboundToken: string;
  /** Bearer required on the advisor's inbound POSTs; none pass without it. */
  inboundToken: string;
  /** This deployment's address on the wire (display + routing label). */
  address: string;
  /** The advisor's address; names its thread and rides on outbound payloads. */
  peerAddress: string;
  /** The advisor's display label for logs and payload metadata. */
  peerLabel: string;
  /** Resolves pending asks; absent in send-only processes (the worker). */
  askStore?: GrokbotAskStore | undefined;
}

/** One question on the wire, POSTed to the advisor's webhook. */
export interface GrokbotOutboundPayload {
  type: "question";
  threadId: string;
  from: string;
  /** 大娃's address this question is addressed to. */
  to: string;
  toLabel: string;
  /** Echoed verbatim by the advisor's reply; ties the answer to the waiting ask. */
  correlation: string | null;
  content: string;
  /** Questions always start at zero; replies at one are never re-forwarded. */
  hop: 0;
  sentAt: string;
}

interface GrokbotInboundBody {
  type?: unknown;
  from?: unknown;
  fromLabel?: unknown;
  content?: unknown;
  correlation?: unknown;
  hop?: unknown;
}

type ParsedInbound =
  | {
      ok: true;
      value: {
        type: string;
        content: string;
        from?: unknown;
        fromLabel?: unknown;
        correlation?: unknown;
        hop?: unknown;
      };
    }
  | { ok: false; error: string };

function parseInbound(body: unknown): ParsedInbound {
  if (typeof body !== "object" || body === null)
    return { ok: false, error: "Body must be a JSON object" };
  const raw = body as GrokbotInboundBody;
  const type = typeof raw.type === "string" && raw.type ? raw.type : "reply";
  const content = typeof raw.content === "string" ? raw.content : "";
  if (type !== "status" && !content.trim()) return { ok: false, error: "content is required" };
  if (
    raw.correlation !== undefined &&
    typeof raw.correlation === "string" &&
    !/^[A-Za-z0-9-]{1,80}$/.test(raw.correlation)
  ) {
    return { ok: false, error: "correlation must be a short opaque id" };
  }
  if (raw.hop !== undefined && typeof raw.hop !== "number") {
    return { ok: false, error: "hop must be a number" };
  }
  return { ok: true, value: { ...raw, type, content } };
}

/** Constant-time bearer check: hash both sides so length and timing leak nothing. */
function bearerMatches(header: string | null | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const presented = createHash("sha256").update(match[1].trim()).digest();
  const configured = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presented, configured);
}

/**
 * The tool writes the correlation as the question's first line, so the advisor
 * can echo it without any structured channel and the adapter can split it back
 * out. Plain questions (no leading marker) send uncorrelated.
 */
function splitCorrelation(text: string): { correlation: string | null; body: string } {
  const newline = text.indexOf("\n");
  const head = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (
    head.startsWith(GROKBOT_CORRELATION_PREFIX) &&
    head.length <= 80 &&
    /^[A-Za-z0-9-]+$/.test(head)
  ) {
    return { correlation: head, body: newline === -1 ? "" : text.slice(newline + 1).trimStart() };
  }
  return { correlation: null, body: text };
}

function messageText(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if (typeof message === "object" && message !== null) {
    const candidate = message as { markdown?: unknown; text?: unknown };
    if (typeof candidate.markdown === "string") return candidate.markdown;
    if (typeof candidate.text === "string") return candidate.text;
  }
  throw new NotImplementedError("grokbot adapter only accepts text messages");
}

export class GrokbotAdapter implements Adapter {
  readonly name = GROKBOT_PROVIDER;
  constructor(readonly config: GrokbotAdapterConfig) {}

  get userName() {
    return this.config.address;
  }
  get botUserId(): string | undefined {
    return undefined;
  }
  /** The SDK hands its instance here; this adapter drives no Chat-side inbound. */
  async initialize(): Promise<void> {}

  async handleWebhook(request: Request, _options?: WebhookOptions): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }
    if (!bearerMatches(request.headers.get("authorization"), this.config.inboundToken)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const rawBuf = await request.arrayBuffer();
    if (rawBuf.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBuf));
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = parseInbound(body);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const event = parsed.value;

    // Delivery statuses need no reply and no pushback of any kind.
    if (event.type === "status") return Response.json({ ok: true, action: "ignored" });

    // The only supported inbound: a reply tied to a pending ask. It fills the
    // waiting tool call directly — no messaging run, no identity, no echo.
    // Correlation wins over the hop guard: a normal reply carries hop 1.
    if (typeof event.correlation === "string" && event.correlation) {
      const store = this.config.askStore;
      if (!store) {
        getLogger().warn("grokbot reply arrived in a process without an ask store", {
          correlation: event.correlation,
        });
        return Response.json(
          { ok: false, action: "dropped", reason: "no_ask_store" },
          { status: 200 },
        );
      }
      let resolved = false;
      try {
        resolved = await store.resolveReply(event.correlation, event.content);
      } catch (error) {
        getLogger().error("grokbot ask store failed to resolve a reply", error);
        return Response.json({ ok: false, action: "retry" }, { status: 500 });
      }
      if (!resolved) {
        getLogger().info("grokbot reply matched no pending ask", {
          correlation: event.correlation,
        });
        return Response.json({ ok: false, action: "dropped", reason: "unknown_correlation" });
      }
      getLogger().info("grokbot reply resolved a pending ask", { correlation: event.correlation });
      return Response.json({ ok: true, action: "resolved" });
    }

    // Hop guard: anything already forwarded once and not tied to a pending ask
    // is never processed again, so a misbehaving peer cannot bounce the
    // conversation back and forth.
    if (typeof event.hop === "number" && event.hop >= 1) {
      getLogger().warn("grokbot inbound dropped at hop guard", { from: event.from });
      return Response.json({ ok: false, action: "dropped", reason: "hop_limit" });
    }

    // Uncorrelated posts (the advisor starting a topic) are out of scope for a
    // consult channel: log and drop rather than mint an unrelated messaging run.
    getLogger().info("grokbot dropped an uncorrelated inbound post", { from: event.from });
    return Response.json({ ok: false, action: "dropped", reason: "uncorrelated_not_supported" });
  }

  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const text = messageText(message);
    const { correlation, body } = splitCorrelation(text);
    const payload: GrokbotOutboundPayload = {
      type: "question",
      threadId,
      from: this.config.address,
      to: this.config.peerAddress,
      toLabel: this.config.peerLabel,
      correlation,
      content: body,
      hop: 0,
      sentAt: new Date().toISOString(),
    };
    const response = await fetch(this.config.outboundUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.outboundToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GROKBOT_SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`grokbot outbound POST failed with ${response.status}: ${snippet}`);
    }
    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { id: correlation ?? randomUUID(), raw, threadId };
  }

  /** Channel 1:1s only; the peer address is the whole conversation space. */
  isDM(): boolean {
    return true;
  }
  encodeThreadId(platformData: GrokbotThreadId): string {
    return encodeGrokbotThreadId(platformData);
  }
  decodeThreadId(threadId: string): GrokbotThreadId {
    return decodeGrokbotThreadId(threadId);
  }
  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }
  async openDM(userId: string): Promise<string> {
    return encodeGrokbotThreadId({ peer: userId });
  }
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }
  async startTyping(): Promise<void> {}
  /** Read receipts would only echo back; the channel pushes nothing. */
  async markAsRead(): Promise<void> {}
  async disconnect(): Promise<void> {}

  // Inbound never flows through the Chat SDK on this channel (replies resolve
  // pending asks before any run logic), so the history and interaction surface
  // stays unimplemented, exactly like the Lark adapter's unsupported calls.
  parseMessage(): never {
    throw new NotImplementedError("grokbot inbound does not flow through the Chat SDK");
  }
  async fetchMessages(): Promise<never> {
    throw new NotImplementedError("grokbot keeps no message history");
  }
  async fetchThread(): Promise<never> {
    throw new NotImplementedError("grokbot has no thread metadata");
  }
  async fetchMessage(): Promise<never> {
    throw new NotImplementedError("grokbot has no message history");
  }
  async addReaction(): Promise<never> {
    throw new NotImplementedError("grokbot has no reactions");
  }
  async removeReaction(): Promise<never> {
    throw new NotImplementedError("grokbot has no reactions");
  }
  async deleteMessage(): Promise<never> {
    throw new NotImplementedError("grokbot messages cannot be deleted");
  }
  async editMessage(): Promise<never> {
    throw new NotImplementedError("grokbot messages cannot be edited");
  }
}
