import type { AdapterContext } from "@rakazo/adapter-kit";
import * as db from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerTools } from "./run-tools-computer.js";
import { fileTools } from "./run-tools-files.js";
import { memoryTools } from "./run-tools-memory.js";
import { STALE_TURN_ATTACHMENT_ERROR } from "./turn-attachment-gate.js";

const earlierAttachment = {
  messages: [
    {
      messageId: "earlier",
      text: "Signed copy attached",
      attachments: [
        {
          artifactId: "old",
          name: "shot.png",
          mimeType: "image/png",
          size: 4,
          path: "attachments/old.png",
        },
      ],
    },
  ],
};

const context = {
  operationId: "1",
  traceId: "1",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
} as AdapterContext;

function toolCtx(paths: string[]) {
  const readFile = vi.fn(async () => new Uint8Array([1]));
  const act = vi.fn();
  const get = vi.fn();
  const ctx = {
    deps: {
      events: { append: vi.fn(async () => undefined) },
      sandbox: { readFile, act },
      artifacts: {},
      prisma: { taughtSkill: { findFirst: async () => null } },
    },
    run: { id: "run", spaceId: "space", userId: "user", threadId: "thread", botId: "bot" },
    runId: "run",
    bot: { id: "bot" },
    thread: { id: "thread" },
    secrets: [] as string[],
    context,
    source: { myChatsAllowed: false, channelId: undefined, historySearchBeforeSeq: 0 },
    trust: { receivedOutsideMessage: async () => false },
    computer: {
      turnAttachmentPaths: new Set(paths),
      mode: "dedicated" as const,
      heldForTakeover: false,
      checkpoint: { markDirty() {} },
      get,
      copyEarlierFiles: vi.fn(),
    },
  };
  return { ctx, readFile, act, get };
}

describe("text follow-ups cannot open an earlier attachment", () => {
  const call = (name: string, path: string) => ({
    name,
    args: { path },
    executionId: "call-1",
    finish: async (result: unknown) => result,
  });

  it("refuses open_path and attach_file without reading the old file", async () => {
    const stale = toolCtx(["attachments/new.png"]);
    const opened = await computerTools.open_path!(
      stale.ctx as never,
      call("open_path", "attachments/old.png") as never,
    );
    const attached = await fileTools.attach_file!(
      stale.ctx as never,
      call("attach_file", "attachments/old.png") as never,
    );
    expect(opened).toMatchObject({
      error: STALE_TURN_ATTACHMENT_ERROR,
      path: "attachments/old.png",
    });
    expect(attached).toMatchObject({
      error: STALE_TURN_ATTACHMENT_ERROR,
      path: "attachments/old.png",
    });
    expect(stale.readFile).not.toHaveBeenCalled();
    expect(stale.act).not.toHaveBeenCalled();
    expect(stale.get).not.toHaveBeenCalled();
  });
});

describe("history search does not put an earlier attachment on the computer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the message without a workspace path and does not register the file", async () => {
    vi.spyOn(db, "searchHistory").mockResolvedValue(earlierAttachment as never);
    const { ctx } = toolCtx([]);
    const result = (await memoryTools.search_history!(
      ctx as never,
      {
        name: "search_history",
        args: { query: "shot" },
        executionId: "call-1",
        finish: async (value: unknown) => value,
      } as never,
    )) as {
      messages: Array<{ attachments: Array<{ name: string; path?: string }> }>;
    };
    expect(result.messages[0]?.attachments[0]).toMatchObject({ name: "shot.png" });
    expect(result.messages[0]?.attachments[0]?.path).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("attachments/");
    expect(ctx.computer.copyEarlierFiles).not.toHaveBeenCalled();
    expect(ctx.computer.turnAttachmentPaths.size).toBe(0);
  });

  it("reads an earlier message without copying its attachment onto the computer", async () => {
    vi.spyOn(db, "readHistory").mockResolvedValue(earlierAttachment as never);
    const { ctx } = toolCtx([]);
    const result = (await memoryTools.read_history!(
      ctx as never,
      {
        name: "read_history",
        args: { messageId: "earlier" },
        executionId: "call-1",
        finish: async (value: unknown) => value,
      } as never,
    )) as { messages: Array<{ attachments: Array<{ name: string; path?: string }> }> };
    expect(result.messages[0]?.attachments[0]).toMatchObject({ name: "shot.png" });
    expect(result.messages[0]?.attachments[0]?.path).toBeUndefined();
    expect(ctx.computer.copyEarlierFiles).not.toHaveBeenCalled();
    expect(ctx.computer.turnAttachmentPaths.size).toBe(0);
  });
});
