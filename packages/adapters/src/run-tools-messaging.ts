import { posix } from "node:path";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  botAddressNotFoundError,
  isBackgroundRunTrigger,
  redactSecrets,
  resolveBotAddress,
} from "@rakazo/core";
import {
  connectAgent,
  messageConnectedAgent,
  respondAgentConnection,
} from "./agent-connections.js";
import { startBackgroundHelper } from "./background-helpers.js";
import { messageBot } from "./bot-messages.js";
import { endCallFromTool, requestUserCall } from "./call-request.js";
import { normalizeWorkspacePath, resolveBotWorkspacePath } from "./computer-support.js";
import { createGrokbotAsk, failGrokbotAsk, waitGrokbotReply } from "./grokbot/ask-store.js";
import { handoffToGroupBot } from "./group-handoff.js";
import type { RunContext } from "./run-context.js";
import {
  canPostLongTaskHeadsUp,
  canPublishDurableProgress,
  flushProgress,
  progressSinceBudgetStart,
  publishInterimMessage,
  publishMidTurnNarration,
  showNarrationStatus,
} from "./run-progress.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import type { AttachmentBlock } from "./run-tools-files.js";
import { readWorkspaceFile, saveWorkspaceFile } from "./run-tools-files.js";
import {
  clampUserProgressMessage,
  isProgressMessageTruncated,
  MID_TURN_PROGRESS_MAX_PER_RUN,
  MID_TURN_PROGRESS_MIN_TURN_AGE_MS,
  messageUserMaxLength,
  midTurnProgressBudgetUsed,
} from "./user-progress.js";

const ZIP_HELPS = new Set(["file not found or unreadable", "unsupported attachment type"]);

/** `recipientId` is the bot the files were prepared for; delivery must go to that same bot. */
type SentFiles = { files: AttachmentBlock[]; sharedPaths: string[]; recipientId?: string };

/**
 * A send that delivered nothing. `refused` marks the ones where repeating the same call cannot
 * deliver anything either, so the run-level guard counts them per tool instead of per argument
 * shape — reworded retries change the shape and would otherwise reset the count.
 */
function refusal(error: string) {
  return { ok: false as const, refused: true as const, error };
}

/** The refusal a caller should see for a prepared send, or the plain error when it is fixable. */
function refusalOrError(prepared: { error: string; refused?: true }) {
  return prepared.refused ? refusal(prepared.error) : { error: prepared.error };
}

/** Bounds one advisor consultation: 5s minimum, 30 minutes maximum. */
const ADVISOR_QUESTION_MAX = 20_000;
const ADVISOR_TIMEOUT_MIN_MS = 5_000;
const ADVISOR_TIMEOUT_MAX_MS = 1_800_000;
const ADVISOR_TIMEOUT_DEFAULT_MS = 600_000;

function advisorTimeoutMs(value: unknown): number {
  const parsed = Number(value);
  const fallbackRaw = Number(process.env.MESSAGING_GROKBOT_REPLY_TIMEOUT_MS ?? "");
  const fallback =
    Number.isFinite(fallbackRaw) && fallbackRaw > 0 ? fallbackRaw : ADVISOR_TIMEOUT_DEFAULT_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(Math.max(fallback, ADVISOR_TIMEOUT_MIN_MS), ADVISOR_TIMEOUT_MAX_MS);
  }
  return Math.min(Math.max(parsed, ADVISOR_TIMEOUT_MIN_MS), ADVISOR_TIMEOUT_MAX_MS);
}

function advisorErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the caller asked to block on the answer. Fire-and-forget is the
 * default, so a caller opts in explicitly: `wait: true`, or a positive
 * `timeout_ms` (which only makes sense when someone is waiting).
 */
export function advisorWaitRequested(args: Record<string, unknown>): boolean {
  if (args.wait === true) return true;
  const raw = Number(args.timeout_ms);
  return Number.isFinite(raw) && raw > 0;
}

/**
 * Files a bot passes by path to another bot. A recipient on the same computer reads them
 * where they are. One elsewhere, or one that cannot be told apart, gets saved copies, filed
 * under the chat that shows them: its own, or the group's for a handoff. Every file is read
 * before any is saved, so a bad path leaves nothing behind.
 */
async function prepareSentFiles(
  ctx: RunContext,
  call: ToolCall,
  recipient: { botId?: string; name?: string; groupId?: string },
): Promise<{ error: string; refused?: true } | SentFiles> {
  const raw = call.args.files;
  if (raw === undefined || raw === null) return { files: [], sharedPaths: [] };
  if (!Array.isArray(raw) || raw.some((path) => typeof path !== "string" || !path.trim())) {
    return { error: "files must be a list of file paths" };
  }
  const paths = [...new Set(raw.map((path: string) => path.trim()))];
  if (!paths.length) return { files: [], sharedPaths: [] };
  if (paths.length > ATTACHMENT_MAX_COUNT) {
    return { error: `send at most ${ATTACHMENT_MAX_COUNT} files; zip the rest into one file` };
  }
  const { target, candidates } = await findRecipient(ctx, recipient);
  if (!target) return { error: botAddressNotFoundError(candidates, recipient), refused: true };
  const { bot } = ctx;
  if (
    bot.computerId &&
    !bot.computerSwitching &&
    !target.computerSwitching &&
    target.computerId === bot.computerId
  )
    return withRecipient(await sharedFiles(ctx, call, paths), target.id);
  const read: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const path of paths) {
    const file = await readWorkspaceFile(ctx, call, path);
    if ("error" in file) {
      // The recipient has its own computer, so a folder or raw source file has to travel zipped.
      const hint = ZIP_HELPS.has(file.error) ? "; zip it and send the zip" : "";
      return { error: `${path}: ${file.error}${hint}. Nothing was sent.` };
    }
    read.push({ path, bytes: file.bytes });
  }
  const owner = recipient.groupId
    ? { botId: bot.id, groupId: recipient.groupId }
    : { botId: target.id };
  const files: AttachmentBlock[] = [];
  for (const file of read) {
    try {
      files.push((await saveWorkspaceFile(ctx, call, file.path, file.bytes, owner)).block);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "could not save the file";
      return { error: `${file.path}: ${reason}. Nothing was sent.` };
    }
  }
  return { files, sharedPaths: [], recipientId: target.id };
}

function withRecipient(prepared: { error: string } | SentFiles, recipientId: string) {
  return "error" in prepared ? prepared : { ...prepared, recipientId };
}

/** The bots a recipient could name: the sender's own, or the group's members for a handoff. */
async function recipientCandidates(ctx: RunContext, recipient: { groupId?: string }) {
  const { run, deps } = ctx;
  return deps.prisma.bot.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      archivedAt: null,
      ...(recipient.groupId ? { groupMembers: { some: { groupId: recipient.groupId } } } : {}),
    },
    select: { id: true, name: true, computerId: true, computerSwitching: true },
  });
}

/** The bot a message or handoff names, among the sender's bots or the group's members. */
async function findRecipient(
  ctx: RunContext,
  recipient: { botId?: string; name?: string; groupId?: string },
) {
  const { bot } = ctx;
  // A bot is not one of its own teammates, so it is not offered as a target either.
  const candidates = (await recipientCandidates(ctx, recipient)).filter(
    (candidate) => candidate.id !== bot.id,
  );
  return { target: resolveBotAddress(candidates, recipient), candidates };
}

/** Paths on the shared computer, checked to exist, as any bot on it can address them. */
async function sharedFiles(
  ctx: RunContext,
  call: ToolCall,
  paths: string[],
): Promise<{ error: string } | SentFiles> {
  let computer: Awaited<ReturnType<typeof ctx.computer.get>>;
  try {
    computer = await ctx.computer.get("tool", call.name);
  } catch {
    return { error: "could not reach your computer. Nothing was sent." };
  }
  const sharedPaths: string[] = [];
  for (const path of paths) {
    let stored: string;
    try {
      stored = normalizeWorkspacePath(resolveBotWorkspacePath(ctx.computer.mode, ctx.bot.id, path));
    } catch {
      return { error: `${path}: path is outside the computer. Nothing was sent.` };
    }
    const parent = posix.dirname(stored);
    // A folder that does not exist fails to list on real computers too, so a listing error
    // cannot be told apart from a wrong path; the error names both.
    const entries = await ctx.deps.sandbox
      .listFiles(computer, parent === "." ? "" : parent, ctx.context)
      .catch(() => undefined);
    if (!entries) {
      return {
        error: `${path}: not found, or your computer could not be read. Nothing was sent.`,
      };
    }
    if (!stored || !entries.some((entry) => normalizeWorkspacePath(entry.path) === stored)) {
      return { error: `${path}: not found. Nothing was sent.` };
    }
    // A path is shown verbatim, so one that holds a secret is refused rather than shown redacted.
    if (redactSecrets(stored, ctx.secrets) !== stored) {
      return { error: "one of the paths can't be shared. Nothing was sent." };
    }
    sharedPaths.push(stored);
  }
  return { files: [], sharedPaths };
}

/**
 * Checked before any file is read or copied: shared paths are added to the message, so a blank
 * one must be caught first, and an oversized one would leave copies behind for nothing.
 */
function messageError(ctx: RunContext, message: unknown): string | undefined {
  const text = redactSecrets(String(message ?? ""), ctx.secrets).trim();
  if (!text) return "message is required";
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return BOT_MESSAGE_TOO_LONG;
}

/**
 * The message as delivered: shared paths are listed where the recipient reads its task. The list
 * counts toward the message limit, so a message it would push over is refused with the room left.
 */
function deliveredMessage(
  ctx: RunContext,
  message: unknown,
  sharedPaths: string[],
): { error: string } | { message: string } {
  const text = redactSecrets(String(message ?? ""), ctx.secrets);
  if (!sharedPaths.length) return { message: text };
  const list = `\n\nFiles on our shared computer:\n${sharedPaths.map((path) => `- ${path}`).join("\n")}`;
  const room = BOT_MESSAGE_MAX_LENGTH - list.length;
  if (text.trim().length > room) {
    return {
      error: `with the file list added, the message must stay under ${Math.max(room, 0)} characters. Nothing was sent.`,
    };
  }
  return { message: `${text.trim()}${list}` };
}

const RELAY_MAX_TARGETS = 20;

type RelayTarget = { bot_id?: string; confirm_name?: string };

/** Parse relay_to_bots targets from targets[] / confirm_names[] / bot_ids[]. */
function parseRelayTargets(args: Record<string, unknown>): { error: string } | RelayTarget[] {
  const out: RelayTarget[] = [];
  const push = (bot_id?: string, confirm_name?: string) => {
    const id = bot_id?.trim() || undefined;
    const name = confirm_name?.trim() || undefined;
    if (!id && !name) return { error: "each target needs bot_id or confirm_name" as const };
    out.push({ bot_id: id, confirm_name: name });
    return undefined;
  };
  const raw = args.targets;
  if (Array.isArray(raw) && raw.length) {
    for (const item of raw) {
      if (typeof item === "string") {
        const err = push(undefined, item);
        if (err) return err;
        continue;
      }
      if (!item || typeof item !== "object") {
        return { error: "each target must be a string name or {bot_id?, confirm_name?}" };
      }
      const o = item as Record<string, unknown>;
      const err = push(
        o.bot_id != null ? String(o.bot_id) : undefined,
        o.confirm_name != null
          ? String(o.confirm_name)
          : o.name != null
            ? String(o.name)
            : undefined,
      );
      if (err) return err;
    }
  }
  const names = args.confirm_names;
  if (Array.isArray(names)) {
    for (const n of names) {
      if (typeof n !== "string" || !n.trim()) {
        return { error: "confirm_names must be a list of non-empty strings" };
      }
      out.push({ confirm_name: n.trim() });
    }
  }
  const ids = args.bot_ids;
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) {
        return { error: "bot_ids must be a list of non-empty strings" };
      }
      out.push({ bot_id: id.trim() });
    }
  }
  if (!out.length) {
    return { error: "targets, confirm_names, or bot_ids is required" };
  }
  if (out.length > RELAY_MAX_TARGETS) {
    return { error: `at most ${RELAY_MAX_TARGETS} targets per relay` };
  }
  return out;
}

/** Messages to the user, other bots and connected agents, and calls. */
export const messagingTools: ToolHandlers = {
  async call_user(ctx, call) {
    const { deps, run, thread } = ctx;
    const { args } = call;
    if (
      ctx.source.messagingChannelRun ||
      thread.groupId ||
      ctx.source.voiceCall ||
      isBackgroundRunTrigger(run.trigger)
    ) {
      return call.finish({ error: "Calls require a one-to-one chat." });
    }
    return call.finish(
      await requestUserCall(deps, run, {
        reason: String(args.reason ?? ""),
        opening: String(args.opening ?? ""),
      }),
    );
  },
  async end_call(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    return call.finish(
      await endCallFromTool(
        deps,
        run,
        thread.id,
        bot.id,
        args,
        ctx.source.callClientNonce,
        ctx.source.callEndRun,
      ),
    );
  },
  async request_takeover() {
    return { ok: true };
  },
  async run_subagent(ctx, call) {
    const { args } = call;
    if (args.background === true) {
      return call.finish(
        await startBackgroundHelper(ctx, {
          name:
            String(args.name ?? "helper")
              .trim()
              .slice(0, 80) || "helper",
          task: redactSecrets(String(args.task ?? "").trim(), ctx.secrets),
          instructions: redactSecrets(String(args.instructions ?? "").trim(), ctx.secrets),
          modelProvider: String(args.model_provider ?? "").trim(),
          modelId: String(args.model_id ?? "").trim(),
          executionId: call.executionId,
          effectKey: call.effectKey,
        }),
      );
    }
    return {
      ok: true,
      result: String(args.task ?? "done."),
    };
  },
  async message_user(ctx, call) {
    const { args } = call;
    const { reply } = ctx.state;
    const rawMessage = redactSecrets(String(args.message ?? ""), ctx.secrets);
    const maxLength = messageUserMaxLength();
    const text = clampUserProgressMessage(rawMessage, maxLength);
    if (!text) return call.finish({ error: "message is required" });
    const truncated = isProgressMessageTruncated(rawMessage, maxLength);
    await flushProgress(ctx);
    // Text written before an answer to the person's mid-task message doesn't use up the
    // allowance meant for that answer.
    const answering = reply.steeringReplyPending;
    reply.steeringReplyPending = false;
    await showNarrationStatus(ctx, await publishMidTurnNarration(ctx));
    // A mid-task message handled meanwhile may have granted a new allowance; keep it.
    reply.steeringReplyPending ||= answering;
    if (
      ctx.replyMode === "chat" &&
      !canPublishDurableProgress(reply) &&
      !canPostLongTaskHeadsUp(ctx)
    ) {
      // A refusal has to look like one. Reporting `ok: true` with a note saying "not posted"
      // read as a success with a caveat, so a model that had more to say reworded the call and
      // tried again until the loop guard stopped the run — hundreds of times in the worst case.
      //
      // Only a spent budget is final: no later call in this run can post anything. The
      // first-seconds refusal clears itself with time, so it must not feed the run-level streak
      // that ends the turn — a run that finishes in under a minute would be stopped with its
      // answer never delivered.
      const budgetUsed = midTurnProgressBudgetUsed(progressSinceBudgetStart(reply));
      return call.finish({
        ok: false,
        ...(budgetUsed ? { refused: true } : {}),
        error: budgetUsed
          ? `Progress budget for this run is used up (${MID_TURN_PROGRESS_MAX_PER_RUN}/${MID_TURN_PROGRESS_MAX_PER_RUN}). Nothing was sent and retrying will not help. Put the remaining content in your final reply.`
          : `Nothing was sent: no progress update can be posted in the first ${MID_TURN_PROGRESS_MIN_TURN_AGE_MS / 1000} seconds of a turn. Do not retry this call — put this content in your final reply instead, where the person reads it.`,
      });
    }
    await publishInterimMessage(ctx, text, true);
    // The person already has this message; notes written before it are no longer a missing answer.
    if (ctx.replyMode === "messages") {
      reply.workingNotes.length = 0;
      reply.lastDiscardedMidTurnNarration = "";
    }
    return call.finish(
      truncated
        ? {
            ok: true,
            truncated: true,
            note: `This progress update was cut off at ${maxLength} characters and the user only saw the truncated version above — it did NOT deliver your full content. message_user is for short interim beats only, never the final answer. Put your complete answer in your normal final reply instead of relying on this truncated update.`,
          }
        : { ok: true },
    );
  },
  async ask_grokbot(ctx, call) {
    const { deps, run, bot, context } = ctx;
    const { args, effectKey } = call;
    const question = redactSecrets(String(args.question ?? "").trim(), ctx.secrets);
    if (!question) return call.finish({ error: "question is required" });
    if (!deps.sendToMessagingThread || !deps.advisorThreadId) {
      return call.finish({ error: "The advisor channel is not configured on this deployment." });
    }
    const blocking = advisorWaitRequested(args);
    const timeoutMs = advisorTimeoutMs(args.timeout_ms);
    const body =
      question.length > ADVISOR_QUESTION_MAX
        ? `${question.slice(0, ADVISOR_QUESTION_MAX)}…[truncated]`
        : question;
    let correlation: string;
    try {
      ({ correlation } = await createGrokbotAsk(deps.prisma, {
        botId: bot.id,
        runId: run.id,
        question: body,
        timeoutMs,
        delivery: blocking ? "sync" : "async",
      }));
    } catch (error) {
      return call.finish({ error: `advisor ask setup failed: ${advisorErrorText(error)}` });
    }
    try {
      await deps.sendToMessagingThread(
        {
          threadId: deps.advisorThreadId,
          body: `${correlation}\n${body}`,
          idempotencyKey: effectKey ?? correlation,
        },
        context,
      );
    } catch (error) {
      await failGrokbotAsk(deps.prisma, correlation).catch(() => undefined);
      return call.finish({ error: `advisor send failed: ${advisorErrorText(error)}` });
    }
    // Default: the question is out. The answer lands in this thread later, so
    // this turn is free to carry on instead of spinning for minutes.
    if (!blocking) {
      return call.finish({
        ok: true,
        accepted: true,
        correlation,
        note: "Sent. This call does not wait for an answer: the advisor's reply will be posted into this thread when it arrives, usually minutes later. Do not call ask_grokbot again for this question, and do not keep the turn open for it — continue with what you can do now or end your turn.",
      });
    }
    const reply = await waitGrokbotReply(deps.prisma, correlation, { signal: context.signal });
    if (reply === null) {
      return call.finish({
        ok: false,
        correlation,
        note: `No reply within ${Math.round(timeoutMs / 1000)}s. Continue without it or ask again later; do not keep the user waiting on this channel.`,
      });
    }
    return call.finish({ ok: true, correlation, reply });
  },
  async message_bot(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    const invalid = messageError(ctx, args.message);
    if (invalid) return call.finish({ error: invalid });
    const stored = await prepareSentFiles(ctx, call, {
      botId: args.bot_id ? String(args.bot_id) : undefined,
      name: args.confirm_name ? String(args.confirm_name) : undefined,
    });
    if ("error" in stored) return call.finish(refusalOrError(stored));
    const delivered = deliveredMessage(ctx, args.message, stored.sharedPaths);
    if ("error" in delivered) return call.finish(refusalOrError(delivered));
    const sent = await messageBot(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        bot_id: stored.recipientId ?? (args.bot_id ? String(args.bot_id) : undefined),
        confirm_name: stored.recipientId
          ? undefined
          : args.confirm_name
            ? String(args.confirm_name)
            : undefined,
        message: delivered.message,
        intent: args.intent as "request" | "result" | "question" | "status" | "fyi" | undefined,
        deliveryKey: effectKey,
        files: stored.files,
      },
    );
    // Nothing was delivered, and a reworded repeat delivers nothing either: mark it so the
    // run-level guard sees the retries even though each one has a different message body.
    if (!sent.ok) return call.finish(refusal(sent.error));
    return call.finish({
      ok: true,
      botId: sent.botId,
      name: sent.name,
      note: sent.note,
    });
  },
  async connect_agent(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const result = await connectAgent(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      { address: args.address ? String(args.address) : undefined },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async respond_agent_connection(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const result = await respondAgentConnection(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        accept: Boolean(args.accept),
        connectionId: String(args.connection_id ?? ""),
        connectionVersion: Number(args.connection_version ?? 0),
      },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async message_agent(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    const result = await messageConnectedAgent(
      deps,
      { ...run, sourceMessageId: run.sourceMessageId },
      { id: bot.id, name: bot.name },
      {
        address: args.address ? String(args.address) : undefined,
        message: redactSecrets(String(args.message ?? ""), ctx.secrets),
        deliveryKey: effectKey,
      },
    );
    if (!result.ok) return call.finish({ error: result.error });
    return call.finish(result);
  },
  async handoff_to_bot(ctx, call) {
    const { deps, run, thread } = ctx;
    const { args, effectKey } = call;
    const groupId = args.group_id ? String(args.group_id).trim() : thread.groupId;
    if (!groupId) return call.finish({ error: "group_id is required outside a group chat" });
    const invalid = messageError(ctx, args.message);
    if (invalid) return call.finish({ error: invalid });
    const stored = await prepareSentFiles(ctx, call, {
      botId: args.bot_id ? String(args.bot_id) : undefined,
      name: args.confirm_name ? String(args.confirm_name) : undefined,
      groupId,
    });
    if ("error" in stored) return call.finish(refusalOrError(stored));
    const delivered = deliveredMessage(ctx, args.message, stored.sharedPaths);
    if ("error" in delivered) return call.finish(refusalOrError(delivered));
    const result = await handoffToGroupBot(deps, run, groupId, {
      bot_id: stored.recipientId ?? (args.bot_id ? String(args.bot_id) : undefined),
      confirm_name: stored.recipientId
        ? undefined
        : args.confirm_name
          ? String(args.confirm_name)
          : undefined,
      message: delivered.message,
      deliveryKey: effectKey,
      files: stored.files,
    });
    if ("ok" in result && result.ok && thread.groupId) ctx.state.handedOff = true;
    return call.finish(result);
  },
  async relay_to_bots(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, effectKey } = call;
    if (!String(args.message ?? "").trim()) {
      return call.finish({ ok: false, error: "message is required" });
    }
    const parsed = parseRelayTargets(args as Record<string, unknown>);
    if ("error" in parsed) return call.finish({ ok: false, error: parsed.error });
    const message = redactSecrets(String(args.message), ctx.secrets).trim();
    const intent = args.intent as "request" | "result" | "question" | "status" | "fyi" | undefined;

    type RelayResult = {
      botId?: string;
      name?: string;
      ok: boolean;
      error?: string;
      note?: string;
      replayed?: boolean;
    };
    const results: RelayResult[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < parsed.length; i += 1) {
      const target = parsed[i]!;
      const sent = await messageBot(
        deps,
        { ...run, sourceMessageId: run.sourceMessageId },
        { id: bot.id, name: bot.name },
        {
          bot_id: target.bot_id,
          confirm_name: target.confirm_name,
          message,
          intent,
          // Per-target delivery key so a retry of the whole relay is idempotent per recipient.
          deliveryKey: effectKey
            ? `${effectKey}:${i}:${target.bot_id ?? target.confirm_name ?? i}`
            : undefined,
        },
      );
      if (!sent.ok) {
        results.push({
          botId: target.bot_id,
          name: target.confirm_name,
          ok: false,
          error: sent.error,
        });
        continue;
      }
      if (seenIds.has(sent.botId)) {
        results.push({
          botId: sent.botId,
          name: sent.name,
          ok: true,
          note: `Duplicate of ${sent.name}; already counted in this relay.`,
          replayed: true,
        });
        continue;
      }
      seenIds.add(sent.botId);
      results.push({
        botId: sent.botId,
        name: sent.name,
        ok: true,
        note: sent.note,
        replayed: "replayed" in sent ? sent.replayed : undefined,
      });
    }

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return call.finish({
        ok: false,
        // A relay that reached nobody is a refusal: no relabelled target list will deliver it.
        ...(succeeded.length === 0 ? { refused: true } : {}),
        error: `relay incomplete: ${succeeded.length} ok, ${failed.length} failed`,
        results,
        succeeded: succeeded.map((r) => ({ botId: r.botId, name: r.name })),
        failed: failed.map((r) => ({ botId: r.botId, name: r.name, error: r.error })),
      });
    }
    return call.finish({
      ok: true,
      delivered: succeeded.length,
      results,
    });
  },
};
