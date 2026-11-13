import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import { IMAGE_MAX_EDGE } from "./pi-image-context.js";
import {
  IMAGE_READ_MAX_BYTES,
  imageMimeFromPath,
  imageToolResultFromBytes,
} from "./read-file-image.js";

async function raster(width: number, height: number, format: "png" | "jpeg" | "webp") {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 160 } },
  });
  return pipeline[format]().toBuffer();
}

describe("imageMimeFromPath", () => {
  it("recognizes supported image extensions and ignores other files", () => {
    expect(imageMimeFromPath("charts/plot.png")).toBe("image/png");
    expect(imageMimeFromPath("C:\\\\Users\\\\a\\\\shot.JPG")).toBe("image/jpeg");
    expect(imageMimeFromPath("photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeFromPath("anim.gif")).toBe("image/gif");
    expect(imageMimeFromPath("pic.webp")).toBe("image/webp");
    expect(imageMimeFromPath("notes.txt")).toBeUndefined();
    expect(imageMimeFromPath("deck.pdf")).toBeUndefined();
  });
});

describe("imageToolResultFromBytes", () => {
  it.each([
    ["png", "image/png", "charts/plot.png"],
    ["jpeg", "image/jpeg", "photo.jpg"],
    ["webp", "image/webp", "pic.webp"],
  ] as const)(
    "returns visible %s image content with path and dimensions",
    async (format, mime, path) => {
      const bytes = await raster(320, 240, format);
      const result = await imageToolResultFromBytes({ path, bytes, acceptsImages: true });
      expect(result).toMatchObject({
        kind: "agent_tool_result",
        details: { path, width: 320, height: 240, mimeType: mime },
      });
      expect(result).not.toHaveProperty("error");
      if (!("content" in result)) throw new Error("expected image content");
      expect(result.content[0]).toEqual({
        type: "text",
        text: `Read image ${path} (320×240, ${mime}).`,
      });
      expect(result.content[1]).toMatchObject({ type: "image", mimeType: mime });
      expect(typeof (result.content[1] as { data: string }).data).toBe("string");
      expect((result.content[1] as { data: string }).data.length).toBeGreaterThan(10);
    },
  );

  it("flattens a GIF to a still PNG the model can see", async () => {
    const bytes = await sharp({
      create: { width: 16, height: 12, channels: 3, background: "red" },
    })
      .gif()
      .toBuffer();
    const result = await imageToolResultFromBytes({
      path: "anim.gif",
      bytes,
      acceptsImages: true,
    });
    expect(result).toMatchObject({
      kind: "agent_tool_result",
      details: { path: "anim.gif", width: 16, height: 12, mimeType: "image/png" },
    });
    if (!("content" in result)) throw new Error("expected image content");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Read image anim.gif (16×12, image/png).",
    });
  });

  it("scales an oversized image down to IMAGE_MAX_EDGE", async () => {
    const bytes = await raster(3000, 2000, "png");
    const result = await imageToolResultFromBytes({
      path: "wide.png",
      bytes,
      acceptsImages: true,
    });
    if (!("content" in result) || !("details" in result)) throw new Error("expected image result");
    expect(result.details).toMatchObject({ path: "wide.png", mimeType: "image/png" });
    const width = (result.details as { width: number }).width;
    const height = (result.details as { height: number }).height;
    expect(Math.max(width, height)).toBe(IMAGE_MAX_EDGE);
    expect(width).toBe(IMAGE_MAX_EDGE);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `Read image wide.png (${width}×${height}, image/png); scaled from 3000×2000 to fit ${IMAGE_MAX_EDGE}px.`,
    });
  });

  it("fails clearly when the model cannot see images", async () => {
    const bytes = await raster(16, 16, "png");
    await expect(
      imageToolResultFromBytes({ path: "chart.png", bytes, acceptsImages: false }),
    ).resolves.toEqual({ error: MODEL_CANNOT_SEE_MESSAGE, path: "chart.png" });
  });

  it("fails clearly for invalid image bytes", async () => {
    await expect(
      imageToolResultFromBytes({
        path: "broken.png",
        bytes: new TextEncoder().encode("not an image"),
        acceptsImages: true,
      }),
    ).resolves.toEqual({
      error: "file is not a valid png, jpeg, gif, or webp image",
      path: "broken.png",
    });
  });

  it("fails clearly when the file exceeds the size cap", async () => {
    const bytes = new Uint8Array(IMAGE_READ_MAX_BYTES + 1);
    await expect(
      imageToolResultFromBytes({ path: "huge.png", bytes, acceptsImages: true }),
    ).resolves.toEqual({
      error: "image is too large to feed to the model",
      path: "huge.png",
      size: IMAGE_READ_MAX_BYTES + 1,
    });
  });
});
