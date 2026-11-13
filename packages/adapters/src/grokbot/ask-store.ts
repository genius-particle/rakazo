import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";

/**
 * Pending `ask_grokbot` consultations. The webhook (API process) resolves
 * replies through the store; the tool (worker process) creates asks and polls
 * for answers, so the two processes coordinate entirely through these rows.
 */

export interface GrokbotAskStore {
  /**
   * Fill a pending ask with the advisor's reply. Returns false when the
   * correlation is unknown, already answered, or expired — the webhook then
   * reports the drop to the advisor instead of silently swallowing it.
   */
  resolveReply(correlation: string, reply: string): Promise<boolean>;
}

export function createPrismaGrokbotAskStore(prisma: PrismaClient): GrokbotAskStore {
  return {
    async resolveReply(correlation: string, reply: string) {
      const updated = await prisma.grokbotAsk.updateMany({
        where: { correlation, status: "pending", expiresAt: { gt: new Date() } },
        data: { status: "answered", reply, answeredAt: new Date() },
      });
      return updated.count > 0;
    },
  };
}

export interface CreatedGrokbotAsk {
  correlation: string;
  expiresAt: Date;
}

export async function createGrokbotAsk(
  prisma: PrismaClient,
  input: { botId: string; runId: string; question: string; timeoutMs: number },
): Promise<CreatedGrokbotAsk> {
  const correlation = `re-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + input.timeoutMs);
  await prisma.grokbotAsk.create({
    data: {
      correlation,
      botId: input.botId,
      runId: input.runId,
      question: input.question,
      status: "pending",
      expiresAt,
    },
  });
  return { correlation, expiresAt };
}

export async function failGrokbotAsk(prisma: PrismaClient, correlation: string): Promise<void> {
  await prisma.grokbotAsk.updateMany({
    where: { correlation, status: "pending" },
    data: { status: "failed" },
  });
}

/**
 * Poll for the advisor's reply until it lands or the ask expires. The run's
 * abort signal ends the wait early (the ask itself is left to expire, so a
 * late webhook reply reports `unknown_correlation` instead of vanishing).
 */
export async function waitGrokbotReply(
  prisma: PrismaClient,
  correlation: string,
  options: { signal: AbortSignal; pollMs?: number },
): Promise<string | null> {
  const pollMs = options.pollMs ?? 2_000;
  for (;;) {
    const row = await prisma.grokbotAsk.findUnique({ where: { correlation } });
    if (!row) return null;
    if (row.status === "answered") return row.reply ?? "";
    if (row.expiresAt.getTime() <= Date.now()) {
      await prisma.grokbotAsk
        .update({ where: { id: row.id }, data: { status: "expired" } })
        .catch(() => undefined);
      return null;
    }
    if (await sleep(pollMs, options.signal)) {
      await prisma.grokbotAsk
        .update({ where: { id: row.id }, data: { status: "expired" } })
        .catch(() => undefined);
      return null;
    }
  }
}

/** Sleeps for the delay; resolves true when the signal aborted instead. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
