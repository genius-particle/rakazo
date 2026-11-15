import { escapePromptData, normalizeBotName } from "@rakazo/core";

/** A teammate this space can address: the ids and names message_bot resolves. */
export interface TeammateAddress {
  id: string;
  name: string;
}

/** A name shorter than this matches too much prose to be a bot. */
const BOT_NAME_MIN_LENGTH = 2;
/** Ids are long and hyphenated, so a fragment of one does not appear in ordinary text. */
const BOT_ID_MIN_LENGTH = 4;

/**
 * The teammate this text names or id-tags, if any.
 *
 * Matching is on identity alone — a known name or id — never on whether the prose reads like
 * an instruction. A sentence about the work is not a routing decision; a teammate's name is
 * destination evidence, and the platform acts on it rather than leaving the guess to the model.
 */
export function teammateNamedIn(
  text: string,
  teammates: readonly TeammateAddress[],
): TeammateAddress | undefined {
  const body = normalizeBotName(text ?? "");
  if (!body || teammates.length === 0) return undefined;
  // Longest name first: "Ops Bot" wins over a bot called "Ops" when both would match.
  const byName = [...teammates].sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0));
  for (const mate of byName) {
    const name = normalizeBotName(mate.name ?? "");
    if (name.length >= BOT_NAME_MIN_LENGTH && body.includes(name)) return mate;
  }
  for (const mate of teammates) {
    const id = normalizeBotName(mate.id ?? "");
    if (id.length >= BOT_ID_MIN_LENGTH && body.includes(id)) return mate;
  }
  return undefined;
}

/**
 * The refusal for a user-chat send that names a teammate. Nothing was posted, and the content
 * still has a route: the same text, through the tool that reaches that bot, in this same turn.
 *
 * The copy deliberately offers no second option. The earlier receipts said "do not retry — put
 * the content in your final reply", and that is exactly how a teammate's instruction reached
 * the user: the model followed the instruction it was given.
 */
export function teammateAddressedRefusal(mate: TeammateAddress): string {
  const name = escapePromptData(mate.name ?? "");
  const id = escapePromptData(mate.id);
  return `Nothing was sent: this text addresses ${name} (id: ${id}), and message_user only reaches the user. Send this same message now with message_bot and bot_id ${id} — or relay_to_bots if it is meant for several bots. Do not reword it for the user, and do not leave it for a later turn.`;
}
