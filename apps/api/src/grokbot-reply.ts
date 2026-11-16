import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { GrokbotAnsweredAsk } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Delivers an advisor answer that no run is waiting for.
 *
 * A blocking `ask_grokbot` reads its answer off the ask row itself and needs
 * nothing from here. Every other case — `wait: false`, a wait cut short by an
 * interruption or a lease loss, a reply that lands after the ask's own timeout —
 * has no reader at all. Writing the answer into the thread alone is what left the
 * asking bot sitting there: the text was visible but nothing picked it up until
 * a person typed another message. So this writes the answer **and** starts a
 * normal follow-up run on the bot that asked, in its own thread, prompted to
 * carry on with the task the question belonged to.
 *
 * The one case that writes without waking is a reply to work the person stopped
 * (`wake` unset on a `cancelled` ask): the answer still belongs in the thread,
 * but starting a run would restart exactly what the Stop ended.
 *
 * The run is an ordinary `follow_up`, not a messaging run on the advisor
 * channel: the reply cannot become another question, so the channel still
 * cannot loop.
 *
 * Idempotent by construction: the message carries `advisor-reply:<correlation>`
 * as its client nonce, and the run is created in the same transaction as that
 * message, so a retried webhook can never leave two runs behind.
 */
export function createAdvisorReplyDelivery(deps: {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  peerLabel: string;
}): (ask: GrokbotAnsweredAsk, reply: string) => Promise<void> {
  return async (ask, reply) => {
    const text = reply.trim();
    if (!text) return;
    const target = await resolveTarget(deps.prisma, ask);
    if (!target) {
      getLogger().warn(
        "advisor reply has no thread to land in: neither the run nor the bot is left",
        {
          correlation: ask.correlation,
          runId: ask.runId,
          botId: ask.botId,
        },
      );
      return;
    }
    const blocks: MessageBlock[] = [
      {
        kind: "meta",
        // Keeping the same prefix for both cases lets one grep find every
        // advisor answer, while the suffix tells the reader why it is late.
        text: ask.late ? `顾问（${deps.peerLabel}）答复（迟到）` : `顾问（${deps.peerLabel}）答复`,
      },
      { kind: "text", text },
    ];
    let committed: { seq: number; runId?: string };
    try {
      committed = await deps.prisma.$transaction(async (tx) => {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "bot",
          blocks,
          // The asking bot wrote the question, so it is the bot this answer
          // belongs to — not whoever the run happened to be acting as.
          botId: ask.botId,
          clientNonce: advisorReplyNonce(ask.correlation),
        });
        const runId = ask.wake
          ? await startFollowUpRun(tx, {
              spaceId: target.spaceId,
              threadId: target.threadId,
              botId: ask.botId,
              userId: target.userId,
              messageId: message.id,
              peerLabel: deps.peerLabel,
            })
          : undefined;
        if (runId) {
          await tx.message.update({ where: { id: message.id }, data: { runId } });
        }
        const event = await appendEventInTransaction(tx, {
          spaceId: target.spaceId,
          threadId: target.threadId,
          botId: ask.botId,
          ...(runId ? { runId } : {}),
          type: "thread.message.created",
          payload: { messageId: message.id, seq: message.seq, role: "bot", blocks },
        });
        return { seq: event.seq, ...(runId ? { runId } : {}) };
      }, THREAD_LOCK_TRANSACTION_OPTIONS);
    } catch (error) {
      // A concurrent duplicate POST loses the unique nonce and is expected; a
      // real write failure is already logged by the store's delivery wrapper.
      getLogger().warn("advisor reply could not be written to its thread", {
        correlation: ask.correlation,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await deps.events.notify(target.threadId, committed.seq).catch((error) => {
      getLogger().error("advisor reply realtime notification", error);
    });
    if (committed.runId) {
      await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
        getLogger().error("advisor reply follow-up run enqueue", error);
      });
      getLogger().info("advisor reply woke the bot that asked", {
        correlation: ask.correlation,
        botId: ask.botId,
        runId: committed.runId,
      });
    } else {
      getLogger().info("advisor reply was written without waking the bot", {
        correlation: ask.correlation,
        botId: ask.botId,
        // No wake request means a person stopped this work; a wake request that
        // produced no run means the thread is busy or the bot is archived.
        reason: ask.wake ? "thread busy or bot archived" : "stopped by the user",
      });
    }
  };
}

/** One advisor answer per correlation, per thread: retries collapse onto it. */
function advisorReplyNonce(correlation: string): string {
  return `advisor-reply:${correlation}`;
}

/**
 * The bot's own thread at the time of asking. The run is the direct source of
 * the thread; a run that has since been deleted still has a bot with a thread,
 * and the answer belongs there either way.
 */
async function resolveTarget(
  prisma: PrismaClient,
  ask: GrokbotAnsweredAsk,
): Promise<{ threadId: string; spaceId: string; userId: string } | null> {
  const run = await prisma.run.findUnique({
    where: { id: ask.runId },
    select: { threadId: true, spaceId: true, userId: true, botId: true },
  });
  if (run && run.botId === ask.botId) {
    return { threadId: run.threadId, spaceId: run.spaceId, userId: run.userId };
  }
  const bot = await prisma.bot.findUnique({
    where: { id: ask.botId },
    select: { spaceId: true, userId: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  if (run) {
    getLogger().warn(
      "advisor reply: the asking run belonged to another bot, using the asker's thread",
      {
        correlation: ask.correlation,
        runBotId: run.botId,
        botId: ask.botId,
      },
    );
  }
  return { threadId: bot.thread.id, spaceId: bot.spaceId, userId: bot.userId };
}

/**
 * The run that turns "the answer arrived" into "the bot carried on". Skipped
 * when the thread already holds work: that run reads the answer from the thread
 * on its next turn, and a second run would duplicate the same response.
 */
async function startFollowUpRun(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    messageId: string;
    peerLabel: string;
  },
): Promise<string | undefined> {
  const held = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (held) {
    getLogger().info("advisor reply: thread already has a run, the answer waits for it", {
      threadId: input.threadId,
      runId: held.id,
    });
    return undefined;
  }
  // An archived bot keeps its thread and the answer in it, but must not be woken.
  const bot = await tx.bot.findUnique({
    where: { id: input.botId },
    select: { archivedAt: true },
  });
  if (!bot || bot.archivedAt) {
    getLogger().info("advisor reply: the asking bot is archived, no run started", {
      botId: input.botId,
    });
    return undefined;
  }
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: input.userId,
      prompt: followUpPrompt(input.peerLabel),
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: input.userId,
      status: "queued",
      trigger: "follow_up",
      sourceMessageId: input.messageId,
    },
    select: { id: true },
  });
  return run.id;
}

/**
 * What the woken run is told. The task itself is already in the thread, so this
 * only has to name the new message and forbid the two ways it goes wrong:
 * restating the answer instead of acting on it, and asking the advisor again.
 */
function followUpPrompt(peerLabel: string): string {
  return [
    `The advisor (${peerLabel}) has answered the question you sent. The answer is the message above marked 「顾问（${peerLabel}）答复」.`,
    "Read it and carry on with the task that question belonged to: act on the answer, do not merely repeat it back, and do not send the same question to the advisor again.",
    "If it settles the open decision, finish that work now. If it changes the plan, say what you are doing differently. If it is not enough to act on, ask one sharper follow-up question with ask_grokbot instead of guessing.",
  ].join(" ");
}
