/**
 * Platform copies of chat attachments live at attachments/<file> inside the bot
 * workspace (team computers store the same file under bots/<id>/attachments/<file>).
 * Those copies used to stay for the life of the computer, so a later turn could
 * list them and read an old image as if the user had just sent it.
 * Only paths copied for this turn stay visible to the file tools.
 */

/** Shown to the model instead of the file bytes. */
export const STALE_TURN_ATTACHMENT_ERROR = "this attachment is not part of the current turn";

/** `attachments/<file>` for a platform attachment copy, wherever it is stored. */
export function platformAttachmentKey(path: string): string | null {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const match = /^(?:bots\/[^/]+\/)?(attachments\/[^/]+)$/.exec(normalized);
  return match?.[1] ?? null;
}

/**
 * A listing may return a full workspace path or only the name inside `directory`.
 * The visibility check needs the workspace path either way.
 */
export function listedWorkspacePath(directory: string, entryPath: string): string {
  const entry = entryPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const dir = directory
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!dir || entry.includes("/")) return entry;
  return `${dir}/${entry}`;
}

/** Non-attachment paths stay visible. An attachment file is visible only when this turn copied it. */
export function attachmentTurnVisible(
  path: string,
  allowed: ReadonlySet<string> | undefined,
): boolean {
  const key = platformAttachmentKey(path);
  if (!key) return true;
  return Boolean(allowed?.has(key));
}

/** History and mail may name an earlier file. They must not hand the model a workspace path. */
export function omitAttachmentWorkspacePaths<T>(response: T): T {
  const messages = (response as { messages?: Array<{ attachments?: Array<{ path?: string }> }> })
    .messages;
  if (!messages) return response;
  for (const message of messages) {
    for (const file of message.attachments ?? []) delete file.path;
  }
  return response;
}

export function staleTurnAttachmentError(
  path: string,
  allowed: ReadonlySet<string> | undefined,
): { error: string; path: string } | undefined {
  if (attachmentTurnVisible(path, allowed)) return undefined;
  return { error: STALE_TURN_ATTACHMENT_ERROR, path };
}
