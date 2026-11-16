import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  appendEventInTransaction: vi.fn(async (..._args: unknown[]) => ({ seq: 42 })),
  createThreadMessageInTransaction: vi.fn(async (..._args: unknown[]) => ({
    id: "msg-1",
    seq: 7,
  })),
  THREAD_LOCK_TRANSACTION_OPTIONS: {},
}));
vi.mock("@rakazo/db", () => db);
vi.mock("@rakazo/adapter-kit", () => ({
  runContinueJob: (runId: string) => ({ name: "run.continue", payload: { runId } }),
}));

const { createAdvisorReplyDelivery } = await import("./grokbot-reply.js");

type Run = { threadId: string; spaceId: string; userId: string; botId: string } | null;

function setup(
  run: Run = { threadId: "thread-1", spaceId: "space-1", userId: "user-1", botId: "bot-1" },
  options: {
    activeRun?: { id: string } | null;
    botThread?: { id: string } | null;
    archivedBot?: boolean;
  } = {},
) {
  const tx = {
    message: { update: vi.fn(async (..._args: unknown[]) => undefined) },
    run: {
      findFirst: vi.fn(async () => options.activeRun ?? null),
      create: vi.fn(async () => ({ id: "run-follow-up" })),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    bot: {
      findUnique: vi.fn(async () => ({ archivedAt: options.archivedBot ? new Date() : null })),
    },
  };
  const bot =
    options.botThread === null
      ? null
      : {
          spaceId: "space-1",
          userId: "user-1",
          thread: options.botThread ?? { id: "thread-1" },
        };
  const prisma = {
    run: { findUnique: vi.fn(async (..._args: unknown[]) => run) },
    bot: { findUnique: vi.fn(async (..._args: unknown[]) => bot) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  const notify = vi.fn(async (..._args: unknown[]) => undefined);
  const enqueue = vi.fn(async (..._args: unknown[]) => undefined);
  const deliver = createAdvisorReplyDelivery({
    prisma: prisma as never,
    events: { notify } as never,
    jobs: { enqueue } as never,
    peerLabel: "大娃",
  });
  return { deliver, prisma, notify, enqueue, tx };
}

const ask = {
  correlation: "re-abc",
  botId: "bot-1",
  runId: "run-1",
  question: "should we ship?",
};

describe("delivering an advisor reply into its thread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends a visible bot message carrying the answer", async () => {
    const { deliver, notify, tx } = setup();

    await deliver(ask, "  ship it  ");

    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        threadId: "thread-1",
        role: "bot",
        botId: "bot-1",
        clientNonce: "advisor-reply:re-abc",
        blocks: [
          { kind: "meta", text: "顾问（大娃）答复" },
          { kind: "text", text: "ship it" },
        ],
      }),
    );
    expect(db.appendEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "thread.message.created",
        payload: expect.objectContaining({
          messageId: "msg-1",
          role: "bot",
        }),
      }),
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 42);
  });

  it("starts a follow-up run for the bot that asked when nobody was waiting", async () => {
    const { deliver, enqueue, tx } = setup();

    await deliver({ ...ask, wake: true }, "ship it");

    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-1", threadId: "thread-1" }),
      }),
    );
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          trigger: "follow_up",
          sourceMessageId: "msg-1",
          status: "queued",
        }),
      }),
    );
    // The message belongs to the run that will read it.
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { runId: "run-follow-up" },
    });
    // And the run is handed to the queue rather than left queued forever.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: "run-follow-up" } }),
    );
  });

  it("does not start a second run while one is still waiting on the answer", async () => {
    const { deliver, enqueue, tx } = setup();

    await deliver(ask, "ship it");

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("records a stopped run's answer without restarting the work", async () => {
    // No `wake` means the ask was `cancelled`: the person pressed Stop. The
    // answer is worth keeping in the thread, a new run is not — it would resume
    // exactly what was stopped.
    const { deliver, enqueue, tx } = setup();

    await deliver(ask, "answer that arrived after the stop");

    expect(db.createThreadMessageInTransaction).toHaveBeenCalledTimes(1);
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not stack a run on a thread that is already working", async () => {
    const { deliver, enqueue, tx } = setup(undefined, { activeRun: { id: "run-busy" } });

    await deliver({ ...ask, wake: true }, "ship it");

    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not wake a bot that has since been archived", async () => {
    const { deliver, enqueue, tx } = setup(undefined, { archivedBot: true });

    await deliver({ ...ask, wake: true }, "ship it");

    // The answer is still recorded; only the run is withheld.
    expect(db.createThreadMessageInTransaction).toHaveBeenCalledTimes(1);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("falls back to the asker's own thread when the asking run is gone", async () => {
    const { deliver, enqueue, tx } = setup(null);

    await deliver({ ...ask, wake: true }, "ship it");

    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ threadId: "thread-1", botId: "bot-1" }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("marks an answer that arrived after the wait had ended", async () => {
    const { deliver, tx } = setup();

    await deliver({ ...ask, late: true, wake: true }, "通道正常");

    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        blocks: [
          { kind: "meta", text: "顾问（大娃）答复（迟到）" },
          { kind: "text", text: "通道正常" },
        ],
      }),
    );
  });

  it("writes nothing for an empty answer", async () => {
    const { deliver, notify } = setup();

    await deliver(ask, "   ");

    expect(db.createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes nothing when neither the run nor the bot is left", async () => {
    const { deliver, notify } = setup(null, { botThread: null });

    await deliver(ask, "ship it");

    expect(db.createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
