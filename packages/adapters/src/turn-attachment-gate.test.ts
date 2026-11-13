import { describe, expect, it } from "vitest";
import {
  attachmentTurnVisible,
  listedWorkspacePath,
  omitAttachmentWorkspacePaths,
  platformAttachmentKey,
  STALE_TURN_ATTACHMENT_ERROR,
  staleTurnAttachmentError,
} from "./turn-attachment-gate.js";

const current = new Set(["attachments/new.png"]);

describe("platform attachment paths", () => {
  it("recognizes a bot-relative copy and the same file under a team bot folder", () => {
    expect(platformAttachmentKey("attachments/old.png")).toBe("attachments/old.png");
    expect(platformAttachmentKey("bots/bot-1/attachments/old.png")).toBe("attachments/old.png");
    expect(platformAttachmentKey("/attachments/old.png")).toBe("attachments/old.png");
    expect(platformAttachmentKey("notes/plan.md")).toBeNull();
    expect(platformAttachmentKey("attachments")).toBeNull();
    expect(platformAttachmentKey("charts/plot.png")).toBeNull();
  });

  it("joins a bare listing name onto the directory that was listed", () => {
    expect(listedWorkspacePath("attachments", "old.png")).toBe("attachments/old.png");
    expect(listedWorkspacePath("bots/bot-1/attachments", "old.png")).toBe(
      "bots/bot-1/attachments/old.png",
    );
    expect(listedWorkspacePath("", "notes/plan.md")).toBe("notes/plan.md");
    expect(listedWorkspacePath("attachments", "attachments/old.png")).toBe("attachments/old.png");
  });

  it("hides an earlier attachment from list, read, and open unless this turn copied it", () => {
    expect(attachmentTurnVisible("attachments/old.png", current)).toBe(false);
    expect(attachmentTurnVisible("bots/bot-1/attachments/old.png", current)).toBe(false);
    expect(attachmentTurnVisible("attachments/new.png", current)).toBe(true);
    expect(attachmentTurnVisible("bots/bot-1/attachments/new.png", current)).toBe(true);
    expect(attachmentTurnVisible("charts/plot.png", current)).toBe(true);
    expect(attachmentTurnVisible("notes/plan.md", undefined)).toBe(true);
    expect(staleTurnAttachmentError("attachments/old.png", current)).toEqual({
      error: STALE_TURN_ATTACHMENT_ERROR,
      path: "attachments/old.png",
    });
    expect(staleTurnAttachmentError("attachments/new.png", current)).toBeUndefined();
    expect(staleTurnAttachmentError("https://example.test/old.png", current)).toBeUndefined();
  });

  it("drops a workspace path from a history result and keeps the file name", () => {
    const result = omitAttachmentWorkspacePaths({
      messages: [
        {
          text: "Signed copy attached",
          attachments: [{ name: "shot.png", path: "attachments/old.png" }],
        },
      ],
    });
    expect(result.messages[0]?.attachments[0]).toEqual({ name: "shot.png" });
    expect(JSON.stringify(result)).not.toContain("attachments/");
  });
});
