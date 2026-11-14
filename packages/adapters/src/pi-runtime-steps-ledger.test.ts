import { describe, expect, it } from "vitest";
import { stepsLedgerNote } from "./pi-runtime.js";

describe("stepsLedgerNote", () => {
  it("tallies successes and failures per tool and quotes the last failure reason", () => {
    const note = stepsLedgerNote([
      { name: "message_user", ok: true, at: 1 },
      {
        name: "message_user",
        ok: false,
        at: 2,
        error: "Progress budget for this run is used up (3/3).",
      },
      { name: "message_user", ok: true, at: 3 },
      { name: "shell", ok: false, at: 4 },
    ]);
    expect(note).toContain(
      "message_user ×3（成功 2、失败 1，最后一次失败原因：Progress budget for this run is used up (3/3).）",
    );
    expect(note).toContain("shell ×1（成功 0、失败 1）");
    expect(note).toContain("没有列出的调用一律未发生");
    // 以固定前缀开头，注入机制靠它替换上一条，避免堆积。
    expect(note.startsWith("【事实记账")).toBe(true);
  });

  it("keeps the order the tools were first called in", () => {
    const note = stepsLedgerNote([
      { name: "web_search", ok: true, at: 1 },
      { name: "message_bot", ok: true, at: 2 },
    ]);
    expect(note.indexOf("web_search")).toBeLessThan(note.indexOf("message_bot"));
  });

  it("states the nothing-else-happened rule even with a single call", () => {
    const note = stepsLedgerNote([{ name: "find_tool", ok: true, at: 1 }]);
    expect(note).toContain("find_tool ×1（成功 1、失败 0）");
    expect(note).toContain("不要声称已执行、已成功、已发送或已收到回复");
  });
});
