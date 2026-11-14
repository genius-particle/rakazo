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

const { createAdvisorReplyDelivery } = await import("./grokbot-reply.js");

function setup(
  run: { threadId: string; spaceId: string; botId: string } | null = {
    threadId: "thread-1",
    spaceId: "space-1",
    botId: "bot-1",
  },
) {
  const prisma = {
    run: { findUnique: vi.fn(async (..._args: unknown[]) => run) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true })),
  };
  const notify = vi.fn(async (..._args: unknown[]) => undefined);
  const deliver = createAdvisorReplyDelivery({
    prisma: prisma as never,
    events: { notify } as never,
    peerLabel: "大娃",
  });
  return { deliver, prisma, notify };
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
    const { deliver, notify } = setup();

    await deliver(ask, "  ship it  ");

    expect(db.createThreadMessageInTransaction).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        threadId: "thread-1",
        role: "bot",
        botId: "bot-1",
        blocks: [
          { kind: "meta", text: "顾问（大娃）答复" },
          { kind: "text", text: "ship it" },
        ],
      }),
    );
    expect(db.appendEventInTransaction).toHaveBeenCalledWith(
      { tx: true },
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

  it("writes nothing for an empty answer", async () => {
    const { deliver, notify } = setup();

    await deliver(ask, "   ");

    expect(db.createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes nothing when the asking run is gone", async () => {
    const { deliver, notify } = setup(null);

    await deliver(ask, "ship it");

    expect(db.createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
