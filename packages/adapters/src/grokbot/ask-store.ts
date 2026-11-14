import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * `ask_grokbot` consultations. The webhook (API process) resolves replies
 * through the store; the tool (worker process) creates asks, so the two
 * processes coordinate entirely through these rows.
 *
 * Two ways to ask, told apart by the row's status:
 *  - `sync`  (status `pending`): the tool blocked and polls the row, so the
 *    reply is handed back inside that same run. Nobody else reads it.
 *  - `async` (status `accepted`): the tool returned as soon as the question was
 *    sent, so no run is waiting. The reply is delivered through `onAnswered`,
 *    which appends it to the thread that asked. No status value is invented
 *    beyond what the column already allows, so this needs no migration.
 */

/** How the asker waits: blocking the turn, or fire-and-forget. */
export type GrokbotAskDelivery = "sync" | "async";

/** The row an answered ask came from, as the delivery callback needs it. */
export interface GrokbotAnsweredAsk {
  correlation: string;
  botId: string;
  runId: string;
  question: string;
  /** Set when the reply arrived after the waiter had already given up. */
  late?: boolean;
}

/**
 * How long after expiry a late reply is still worth delivering. A reply that
 * lands minutes late is useful; one that lands next week is noise in a thread
 * the conversation has long left.
 */
export const LATE_REPLY_GRACE_MS = 24 * 60 * 60 * 1000;

export interface GrokbotAskStore {
  /**
   * Fill an open ask with the advisor's reply. Returns false when the
   * correlation is unknown or already answered — the webhook then reports the
   * drop to the advisor instead of silently swallowing it.
   *
   * A reply that arrives after expiry is not a miss: nobody is waiting on the
   * row any more, but the thread that asked still is, so it is delivered there
   * and reported as resolved (`late: true` in the callback).
   */
  resolveReply(correlation: string, reply: string): Promise<boolean>;
}

export interface GrokbotAskStoreOptions {
  /**
   * Delivers a reply that no run is waiting for (an `async` ask) into its
   * thread. Failures are logged, not thrown: the row is already answered and
   * the reply text is still stored, so a delivery bug must not make the advisor
   * retry a webhook it cannot succeed at.
   */
  onAnswered?: (ask: GrokbotAnsweredAsk, reply: string) => Promise<void> | void;
}

const OPEN_STATUSES = ["pending", "accepted"] as const;

export function createPrismaGrokbotAskStore(
  prisma: PrismaClient,
  options: GrokbotAskStoreOptions = {},
): GrokbotAskStore {
  /** Hands a resolved reply to its thread. The row is already updated. */
  async function deliver(
    ask: { correlation: string; botId: string; runId: string; question: string },
    reply: string,
    late: boolean,
  ): Promise<void> {
    try {
      await options.onAnswered?.(
        {
          correlation: ask.correlation,
          botId: ask.botId,
          runId: ask.runId,
          question: ask.question,
          ...(late ? { late: true } : {}),
        },
        reply,
      );
    } catch (error) {
      getLogger().error("grokbot reply could not be delivered to its thread", error);
    }
  }

  return {
    async resolveReply(correlation: string, reply: string) {
      const row = await prisma.grokbotAsk.findFirst({
        where: {
          correlation,
          status: { in: [...OPEN_STATUSES] },
          expiresAt: { gt: new Date() },
        },
        select: { id: true, botId: true, runId: true, question: true, status: true },
      });
      if (!row) {
        // A late reply to an expired ask is still a miss for the waiter, but the
        // row should stop looking open to anyone reading the table.
        await prisma.grokbotAsk
          .updateMany({
            where: {
              correlation,
              status: { in: [...OPEN_STATUSES] },
              expiresAt: { lte: new Date() },
            },
            data: { status: "expired" },
          })
          .catch(() => undefined);

        // Nobody polls an expired row, so the thread is the only audience left.
        // Dropping the answer here is what made a slow advisor look like a
        // broken channel: the work was done and then thrown away.
        const late = await prisma.grokbotAsk.findFirst({
          where: {
            correlation,
            status: "expired",
            expiresAt: { gt: new Date(Date.now() - LATE_REPLY_GRACE_MS) },
          },
          select: { id: true, botId: true, runId: true, question: true },
        });
        if (!late) return false;
        const claimedLate = await prisma.grokbotAsk.updateMany({
          where: { id: late.id, status: "expired" },
          data: { status: "answered", reply, answeredAt: new Date() },
        });
        if (claimedLate.count === 0) return false;
        await deliver(late, reply, true);
        return true;
      }
      const updated = await prisma.grokbotAsk.updateMany({
        // The status is part of the key: two concurrent webhooks for the same
        // correlation cannot both win.
        where: { id: row.id, status: row.status },
        data: { status: "answered", reply, answeredAt: new Date() },
      });
      if (updated.count === 0) return false;

      // A blocking ask polls this row itself; a fire-and-forget ask has no
      // waiter, so the thread is told directly.
      if (row.status === "accepted") await deliver(row, reply, false);
      return true;
    },
  };
}

export interface CreatedGrokbotAsk {
  correlation: string;
  expiresAt: Date;
  delivery: GrokbotAskDelivery;
}

export async function createGrokbotAsk(
  prisma: PrismaClient,
  input: {
    botId: string;
    runId: string;
    question: string;
    /**
     * For a blocking ask, how long the tool waits. For a fire-and-forget ask,
     * how long a late reply is still worth delivering.
     */
    timeoutMs: number;
    /** Defaults to `sync` so an un-updated caller keeps the old behaviour. */
    delivery?: GrokbotAskDelivery;
  },
): Promise<CreatedGrokbotAsk> {
  const correlation = `re-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + input.timeoutMs);
  const delivery = input.delivery ?? "sync";
  await prisma.grokbotAsk.create({
    data: {
      correlation,
      botId: input.botId,
      runId: input.runId,
      question: input.question,
      // `accepted` is the only marker of an async ask; the column is a plain
      // string, so this adds a state rather than a constraint.
      status: delivery === "async" ? "accepted" : "pending",
      expiresAt,
    },
  });
  return { correlation, expiresAt, delivery };
}

export async function failGrokbotAsk(prisma: PrismaClient, correlation: string): Promise<void> {
  await prisma.grokbotAsk.updateMany({
    where: { correlation, status: { in: [...OPEN_STATUSES] } },
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
