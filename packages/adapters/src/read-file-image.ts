import type { AgentToolExecutionResult } from "@rakazo/adapter-kit";
import {
  ATTACHMENT_MAX_BASE64_LENGTH,
  ATTACHMENT_MAX_BYTES,
  isAttachmentImageMimeType,
} from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import { HOST_COMPUTER_MAX_FILE_BYTES } from "./host-computer-protocol.js";
import { MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import { IMAGE_MAX_EDGE } from "./pi-image-context.js";

const SHARP_FORMAT_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
} as const;

type SharpImageFormat = keyof typeof SHARP_FORMAT_MIME;

function isSharpImageFormat(format: string | undefined): format is SharpImageFormat {
  return format !== undefined && Object.hasOwn(SHARP_FORMAT_MIME, format);
}

/** True when the path is a supported still-image file the model can be shown. */
export function imageMimeFromPath(filePath: string): string | undefined {
  const mime = inferAttachmentMimeType(filePath);
  return mime && isAttachmentImageMimeType(mime) ? mime : undefined;
}

export function imageFileTooLargeError(filePath: string, size?: number) {
  return {
    error: "image is too large to feed to the model",
    path: filePath,
    ...(size !== undefined ? { size } : {}),
  };
}

export const IMAGE_READ_MAX_BYTES = Math.min(ATTACHMENT_MAX_BYTES, HOST_COMPUTER_MAX_FILE_BYTES);

/**
 * Turn image bytes into a tool result the model can see, or a clear error.
 * Large edges are scaled to IMAGE_MAX_EDGE; animated sources contribute their first frame.
 */
export async function imageToolResultFromBytes(input: {
  path: string;
  bytes: Uint8Array;
  acceptsImages: boolean;
}): Promise<AgentToolExecutionResult | { error: string; path: string; size?: number }> {
  if (!input.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE, path: input.path };
  }
  if (input.bytes.byteLength > IMAGE_READ_MAX_BYTES) {
    return imageFileTooLargeError(input.path, input.bytes.byteLength);
  }
  try {
    // sharp is a native addon; load it only when an image is processed.
    const { default: sharp } = await import("sharp");
    const decoded = sharp(input.bytes, {
      failOn: "error",
      animated: false,
      limitInputPixels: 50_000_000,
    }).rotate();
    const metadata = await decoded.metadata();
    if (!isSharpImageFormat(metadata.format)) {
      return { error: "file is not a valid png, jpeg, gif, or webp image", path: input.path };
    }
    const sourceWidth = metadata.width ?? 0;
    const sourceHeight = metadata.height ?? 0;
    if (sourceWidth < 1 || sourceHeight < 1) {
      return { error: "file is not a valid png, jpeg, gif, or webp image", path: input.path };
    }
    const needsScale = Math.max(sourceWidth, sourceHeight) > IMAGE_MAX_EDGE;
    // Flatten a first GIF frame to PNG so the model receives one still image.
    const outputFormat: Exclude<SharpImageFormat, "gif"> =
      metadata.format === "gif" ? "png" : metadata.format;
    const pipeline = needsScale
      ? decoded.resize({
          width: IMAGE_MAX_EDGE,
          height: IMAGE_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
      : decoded;
    const rendered = await pipeline[outputFormat]().toBuffer({ resolveWithObject: true });
    const width = rendered.info.width;
    const height = rendered.info.height;
    const data = rendered.data.toString("base64");
    if (data.length > ATTACHMENT_MAX_BASE64_LENGTH) {
      return imageFileTooLargeError(input.path, input.bytes.byteLength);
    }
    const mimeType = SHARP_FORMAT_MIME[outputFormat];
    const scaled =
      needsScale || width !== sourceWidth || height !== sourceHeight
        ? `; scaled from ${sourceWidth}×${sourceHeight} to fit ${IMAGE_MAX_EDGE}px`
        : "";
    return {
      kind: "agent_tool_result",
      content: [
        {
          type: "text",
          text: `Read image ${input.path} (${width}×${height}, ${mimeType})${scaled}.`,
        },
        { type: "image", data, mimeType },
      ],
      details: { path: input.path, width, height, mimeType },
    };
  } catch {
    return { error: "file is not a valid png, jpeg, gif, or webp image", path: input.path };
  }
}
