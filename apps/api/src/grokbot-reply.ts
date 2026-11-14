import type { GrokbotAnsweredAsk } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Delivers an advisor answer that no run is waiting for.
 *
 * `ask_grokbot` now returns as soon as the question is sent, so by the time the
 * advisor's webhook arrives the asking run may be long finished. A blocking ask
 * still polls its row and needs nothing from here; a fire-and-forget ask has no
 * reader at all, so the answer is appended to the thread that asked, as the bot
 * that asked. It is a message write, not a run: nothing re-enters the model on
 * its own, so the answer cannot become a new question and bounce back.
 */
export function createAdvisorReplyDelivery(deps: {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
  peerLabel: string;
}): (ask: GrokbotAnsweredAsk, reply: string) => Promise<void> {
  return async (ask, reply) => {
    const text = reply.trim();
    if (!text) return;
    const run = await deps.prisma.run.findUnique({
      where: { id: ask.runId },
      select: { threadId: true, spaceId: true, botId: true },
    });
    if (!run) {
      getLogger().warn("advisor reply has no thread to land in: run is gone", {
        correlation: ask.correlation,
        runId: ask.runId,
      });
      return;
    }
    const blocks: MessageBlock[] = [
      { kind: "meta", text: `顾问（${deps.peerLabel}）答复` },
      { kind: "text", text },
    ];
    const { seq } = await deps.prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks,
        botId: run.botId,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, seq: message.seq, role: "bot", blocks },
      });
      return { seq: event.seq };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    await deps.events.notify(run.threadId, seq).catch((error) => {
      getLogger().error("advisor reply realtime notification", error);
    });
  };
}
