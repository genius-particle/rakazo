import { describe, expect, it, vi } from "vitest";
import { createGrokbotAsk, createPrismaGrokbotAskStore } from "./ask-store.js";

type Row = {
  id: string;
  correlation: string;
  botId: string;
  runId: string;
  question: string;
  reply: string | null;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
  expiresAt: Date;
};

/**
 * Only the calls the store makes: findFirst filtered by correlation/status/expiry,
 * a conditional updateMany, and create. Enough to prove the state machine without
 * a database.
 */
function fakePrisma(initial: Row | null) {
  const row = initial ? { ...initial } : null;
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    grokbotAsk: {
      findFirst: async ({
        where,
      }: {
        where: {
          correlation: string;
          status?: string | { in: string[] };
          expiresAt?: { gt: Date };
        };
      }) => {
        if (!row || row.correlation !== where.correlation) return null;
        const wanted = where.status
          ? typeof where.status === "string"
            ? [where.status]
            : where.status.in
          : null;
        if (wanted && !wanted.includes(row.status)) return null;
        if (where.expiresAt?.gt && row.expiresAt.getTime() <= where.expiresAt.gt.getTime()) {
          return null;
        }
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; correlation?: string; status: string | { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        updates.push({ where, data });
        if (!row) return { count: 0 };
        if (where.id && row.id !== where.id) return { count: 0 };
        if (where.correlation && row.correlation !== where.correlation) return { count: 0 };
        const expected = typeof where.status === "string" ? [where.status] : where.status.in;
        if (!expected.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return data;
      },
      findUnique: async () => (row ? { ...row } : null),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (row) Object.assign(row, data);
        return row;
      },
    },
  };
  return { prisma: prisma as never, row, updates, creates };
}

function openRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "ask_1",
    correlation: "re-abc",
    botId: "bot_1",
    runId: "run_1",
    question: "should we ship?",
    reply: null,
    status: "pending",
    createdAt: new Date("2026-11-14T00:00:00Z"),
    answeredAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("grokbot ask store", () => {
  it("fills a blocking ask without delivering it to the thread", async () => {
    const { prisma, row } = fakePrisma(openRow({ status: "pending" }));
    const onAnswered = vi.fn(async () => undefined);
    const store = createPrismaGrokbotAskStore(prisma, { onAnswered });

    await expect(store.resolveReply("re-abc", "yes")).resolves.toBe(true);
    expect(row?.status).toBe("answered");
    expect(row?.reply).toBe("yes");
    // The run waiting on the row reads it from there; a second copy in the
    // thread would show the answer twice.
    expect(onAnswered).not.toHaveBeenCalled();
  });

  it("delivers a fire-and-forget ask into its thread", async () => {
    const { prisma, row } = fakePrisma(openRow({ status: "accepted" }));
    const onAnswered = vi.fn(async () => undefined);
    const store = createPrismaGrokbotAskStore(prisma, { onAnswered });

    await expect(store.resolveReply("re-abc", "ship it")).resolves.toBe(true);
    expect(row?.status).toBe("answered");
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(onAnswered).toHaveBeenCalledWith(
      {
        correlation: "re-abc",
        botId: "bot_1",
        runId: "run_1",
        question: "should we ship?",
      },
      "ship it",
    );
  });

  it("reports a second reply for the same correlation as a miss", async () => {
    const { prisma } = fakePrisma(openRow({ status: "accepted" }));
    const onAnswered = vi.fn(async () => undefined);
    const store = createPrismaGrokbotAskStore(prisma, { onAnswered });

    await expect(store.resolveReply("re-abc", "first")).resolves.toBe(true);
    await expect(store.resolveReply("re-abc", "second")).resolves.toBe(false);
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it("misses an unknown correlation", async () => {
    const { prisma } = fakePrisma(openRow({ correlation: "re-other" }));
    const onAnswered = vi.fn(async () => undefined);
    const store = createPrismaGrokbotAskStore(prisma, { onAnswered });

    await expect(store.resolveReply("re-abc", "hello")).resolves.toBe(false);
    expect(onAnswered).not.toHaveBeenCalled();
  });

  it("delivers a reply that arrives after the waiter gave up", async () => {
    const { prisma, row } = fakePrisma(
      openRow({ status: "accepted", expiresAt: new Date(Date.now() - 1_000) }),
    );
    const onAnswered = vi.fn(async () => undefined);
    const store = createPrismaGrokbotAskStore(prisma, { onAnswered });

    // The run stopped waiting 11 seconds ago; the answer is still worth having,
    // so it goes to the thread instead of being thrown away.
    await expect(store.resolveReply("re-abc", "too late but done")).resolves.toBe(true);
    expect(row?.status).toBe("answered");
    expect(row?.reply).toBe("too late but done");
    expect(onAnswered).toHaveBeenCalledWith(
      {
        correlation: "re-abc",
        botId: "bot_1",
        runId: "run_1",
        question: "should we ship?",
        late: true,
      },
      "too late but done",
    );
  });

  it("still refuses a reply that is days past the grace window", async () => {
    const { prisma } = fakePrisma(
      openRow({
        status: "expired",
        expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      }),
    );
    const onAnswered = vi.fn(async () => undefined);
    const store = createPrismaGrokbotAskStore(prisma, { onAnswered });

    await expect(store.resolveReply("re-abc", "ancient")).resolves.toBe(false);
    expect(onAnswered).not.toHaveBeenCalled();
  });

  it("keeps the ask answered even when thread delivery throws", async () => {
    const { prisma, row } = fakePrisma(openRow({ status: "accepted" }));
    const store = createPrismaGrokbotAskStore(prisma, {
      onAnswered: async () => {
        throw new Error("thread is gone");
      },
    });

    // A delivery bug must not turn into a 500 the advisor would retry forever.
    await expect(store.resolveReply("re-abc", "ship it")).resolves.toBe(true);
    expect(row?.status).toBe("answered");
  });
});

describe("createGrokbotAsk", () => {
  it("opens an async ask as accepted and a blocking one as pending", async () => {
    const asyncAsk = fakePrisma(null);
    await createGrokbotAsk(asyncAsk.prisma, {
      botId: "bot_1",
      runId: "run_1",
      question: "q",
      timeoutMs: 1_000,
      delivery: "async",
    });
    expect(asyncAsk.creates[0]?.status).toBe("accepted");

    const syncAsk = fakePrisma(null);
    await createGrokbotAsk(syncAsk.prisma, {
      botId: "bot_1",
      runId: "run_1",
      question: "q",
      timeoutMs: 1_000,
    });
    // An un-updated caller keeps the old blocking behaviour.
    expect(syncAsk.creates[0]?.status).toBe("pending");
  });
});
