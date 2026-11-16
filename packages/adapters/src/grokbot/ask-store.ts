import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * `ask_grokbot` consultations. The webhook (API process) resolves replies
 * through the store; the tool (worker process) creates asks, so the two
 * processes coordinate entirely through these rows.
 *
 * Ways to ask, told apart by the row's status:
 *  - `sync`  (status `pending`): the tool blocked and polls the row, so the
 *    reply is handed back inside that same run. Nobody else reads it.
 *  - `async` (status `accepted`): the tool returned as soon as the question was
 *    sent, so no run is waiting. The reply is delivered through `onAnswered`,
 *    which appends it to the thread that asked and wakes that bot with a run.
 *  - `abandoned` (status `abandoned`): the waiter lost its run to something
 *    other than the person in the chat — a lease loss, a worker restart, a
 *    shutdown. The ask stays answerable, so the reply is claimed and delivered
 *    to the thread with a follow-up run: the work was interrupted, not called
 *    off, and nobody is there to ask again.
 *  - `cancelled` (status `cancelled`): the person pressed Stop. The ask stays
 *    answerable too — the advisor's work should not be thrown away — but the
 *    reply only lands in the thread; **no run is started**, because starting one
 *    would restart exactly what the person just stopped.
 *  - `expired`: the ask outlived its own timeout. A reply that still arrives
 *    within the grace window is delivered as late.
 *
 * The column is a plain string, so these states add no migration.
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
  /**
   * Set when no run is polling the row any more, so the thread needs not only
   * the answer but a run that reads it and carries on with the original task.
   */
  wake?: boolean;
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
   * Delivers a reply that no run is waiting for (an `async`, `abandoned`,
   * `cancelled` or late ask) into its thread, and — when `wake` is set — starts
   * the run that acts on it. Failures are logged, not thrown: the row is
   * already answered and the reply text is still stored, so a delivery bug must
   * not make the advisor retry a webhook it cannot succeed at.
   */
  onAnswered?: (ask: GrokbotAnsweredAsk, reply: string) => Promise<void> | void;
}

/**
 * Statuses whose ask can still be answered: a pending row has a waiter, an
 * accepted one was fire-and-forget, and abandoned / cancelled ones lost their
 * waiter — one to an interruption, the other to a Stop — but not their question.
 */
const OPEN_STATUSES = ["pending", "accepted", "abandoned", "cancelled"] as const;

/** A run that is still working — the only kind that can be polling an ask row. */
const WORKING_RUN_STATUSES = ["queued", "leased", "running"] as const;

/**
 * How a run ended, for the two questions the reply path asks of it: is anyone
 * still polling, and did a person stop this work?
 */
async function runStatusOf(prisma: PrismaClient, runId: string): Promise<string | null> {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
  return run?.status ?? null;
}

export function createPrismaGrokbotAskStore(
  prisma: PrismaClient,
  options: GrokbotAskStoreOptions = {},
): GrokbotAskStore {
  /** Hands a resolved reply to its thread. The row is already updated. */
  async function deliver(
    ask: { correlation: string; botId: string; runId: string; question: string },
    reply: string,
    flags: { late: boolean; wake: boolean },
  ): Promise<void> {
    try {
      await options.onAnswered?.(
        {
          correlation: ask.correlation,
          botId: ask.botId,
          runId: ask.runId,
          question: ask.question,
          ...(flags.late ? { late: true } : {}),
          ...(flags.wake ? { wake: true } : {}),
        },
        reply,
      );
    } catch (error) {
      getLogger().error("grokbot reply could not be delivered to its thread", error);
    }
  }

  /**
   * Whether a run is still in a position to poll this ask. A blocking ask is
   * answered in place while its run works; once that run has ended (or its
   * worker died) the row would be answered into the void, so the thread needs
   * the reply and a run that reads it.
   */
  function stillWaiting(status: string | null): boolean {
    return Boolean(status && (WORKING_RUN_STATUSES as readonly string[]).includes(status));
  }

  return {
    async resolveReply(correlation: string, reply: string) {
      const now = new Date();
      const row = await prisma.grokbotAsk.findFirst({
        where: {
          correlation,
          status: { in: [...OPEN_STATUSES] },
          expiresAt: { gt: now },
        },
        select: {
          id: true,
          correlation: true,
          botId: true,
          runId: true,
          question: true,
          status: true,
        },
      });
      if (!row) {
        // A late reply to an expired ask is still a miss for the waiter, but the
        // row should stop looking open to anyone reading the table.
        await prisma.grokbotAsk
          .updateMany({
            where: {
              correlation,
              status: { in: [...OPEN_STATUSES] },
              expiresAt: { lte: now },
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
          select: { id: true, correlation: true, botId: true, runId: true, question: true },
        });
        if (!late) return false;
        const claimedLate = await prisma.grokbotAsk.updateMany({
          where: { id: late.id, status: "expired" },
          data: { status: "answered", reply, answeredAt: now },
        });
        if (claimedLate.count === 0) return false;
        // A late reply to work the person stopped is still only a message: the
        // Stop is newer than the question.
        const stoppedLate = (await runStatusOf(prisma, late.runId)) === "cancelled";
        await deliver(late, reply, { late: true, wake: !stoppedLate });
        return true;
      }
      const updated = await prisma.grokbotAsk.updateMany({
        // The status is part of the key: two concurrent webhooks for the same
        // correlation cannot both win.
        where: { id: row.id, status: row.status },
        data: { status: "answered", reply, answeredAt: now },
      });
      if (updated.count === 0) return false;

      // Two separate questions, and they do not have the same answer:
      //  - is anyone reading this row? Only a blocking ask whose run still works.
      //  - was the work called off by the person? A `cancelled` row says so, and
      //    a run that ended `cancelled` says so too (a Stop that landed between
      //    the wait being cut and this webhook arriving).
      // The second one outranks the first: writing the answer is right, waking
      // the bot would restart exactly what the Stop ended.
      const runStatus = await runStatusOf(prisma, row.runId);
      const stopped = row.status === "cancelled" || runStatus === "cancelled";
      const readByWaiter = row.status === "pending" && stillWaiting(runStatus);
      if (!readByWaiter) {
        await deliver(row, reply, {
          late: row.status === "abandoned",
          wake: !stopped,
        });
      }
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
 * Poll for the advisor's reply until it lands or the ask expires. An abort ends
 * the wait early but does **not** close the ask, so a reply that arrives after
 * the turn ended still lands in the thread instead of being rejected as an
 * unknown correlation. What it is marked as depends on why the wait ended:
 *
 *  - `cancelled` when the run was stopped by a person. The answer is still worth
 *    writing down, but waking the bot would restart the work that was stopped.
 *  - `abandoned` otherwise (lease loss, worker restart, shutdown): the work was
 *    interrupted rather than called off, so the answer must start a new turn.
 */
export async function waitGrokbotReply(
  prisma: PrismaClient,
  correlation: string,
  options: {
    signal: AbortSignal;
    pollMs?: number;
    /** The run doing the waiting; its status tells a Stop from an interruption. */
    runId?: string;
  },
): Promise<string | null> {
  const pollMs = options.pollMs ?? 2_000;
  for (;;) {
    const row = await prisma.grokbotAsk.findUnique({ where: { correlation } });
    if (!row) return null;
    if (row.status === "answered") return row.reply ?? "";
    if (row.status === "expired" || row.status === "failed") return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await prisma.grokbotAsk
        .updateMany({
          where: { id: row.id, status: { in: ["pending", "accepted", "abandoned", "cancelled"] } },
          data: { status: "expired" },
        })
        .catch(() => undefined);
      return null;
    }
    if (await sleep(pollMs, options.signal)) {
      // The waiter is gone, not the ask. A reply still worth having must not be
      // refused as unknown_correlation — but whether it may start a new turn
      // depends on who ended the wait: a person's Stop, or an interruption.
      const stopped = options.runId
        ? (await runStatusOf(prisma, options.runId).catch(() => null)) === "cancelled"
        : false;
      await prisma.grokbotAsk
        .updateMany({
          where: { id: row.id, status: { in: ["pending", "accepted"] } },
          data: { status: stopped ? "cancelled" : "abandoned" },
        })
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
