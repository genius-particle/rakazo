import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_MEMORY_MAX_BYTES } from "@rakazo/contracts";
import { CORE_BUILTIN_TOOL_NAMES } from "./builtin-tool-bridge.js";
import { byteLength } from "./utf8.js";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

/**
 * P4 记忆自污染闸：拒写「没有/禁用 XXX」且 XXX 是平台内置工具名的假记忆。
 * 覆盖 CORE_BUILTIN + 派单/桥接工具（message_bot 等曾被 find_tool 搜不到后写入）。
 * 逃生口：正文以 `contested:` 开头（主人确认后允许带争议标记写入）。
 *
 * 注意：builtin-tool-bridge ↔ run-tool-selection ↔ memory-tools 有环，
 * CORE_BUILTIN 必须惰性读取，不能在模块顶层 spread。
 */
const MEMORY_TOOL_DENIAL =
  /没有|不存在|找不到|未找到|不可用|不支持|未开放|没有开放|已?禁用|禁用了|无法使用|用不了|调不到|调用不了|搜不到|无此|并无|不具备|未提供|未启用|未开通|not\s+(?:available|supported|found|enabled)|(?:do(?:es)?\s+not|don'?t)\s+have|missing|unavailable|disabled|no\s+such/i;

const MEMORY_POLLUTION_EXTRA = ["message_bot", "relay_to_bots", "find_tool", "use_tool"] as const;

let memoryPollutionToolNames: string[] | undefined;

function pollutionToolNames(): string[] {
  if (!memoryPollutionToolNames) {
    memoryPollutionToolNames = [...CORE_BUILTIN_TOOL_NAMES, ...MEMORY_POLLUTION_EXTRA].sort(
      (a, b) => b.length - a.length,
    );
  }
  return memoryPollutionToolNames;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 若文本在否认平台内置工具存在/可用，返回命中的工具名；否则 null。 */
export function memorySelfPollutionTool(text: string): string | null {
  const content = text.trim();
  if (!content) return null;
  // Owner-confirmed contested notes are allowed through remember/save_memory.
  if (/^contested\s*:/i.test(content)) return null;
  if (!MEMORY_TOOL_DENIAL.test(content)) return null;
  for (const name of pollutionToolNames()) {
    const token = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(name)}(?:[^A-Za-z0-9_]|$)`, "i");
    if (token.test(content)) return name;
  }
  return null;
}

export const MEMORY_SELF_POLLUTION_ERROR = (tool: string) =>
  `【记忆自污染闸】拒绝写入：正文声称平台工具「${tool}」不存在/已禁用/不可用。该工具是内置能力（搜不到≠没有；find_tool 索引不含全部核心工具）。不要把「找不到工具」记成永久事实。若主人明确确认该工具在本环境不可用，请先 message_user 告知主人，再以「contested: ${tool} unavailable (owner-confirmed)」开头重写。`;


/** `forget_memory` is offered only when the provider implements its optional forget verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => semanticMemoryForgets || tool.name !== "forget_memory")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
}

export type MemoryEdit = { content: string } | { error: string; entries: string[] };

/**
 * Adds a fact, or with `oldText` replaces (or, given an empty fact, removes) the
 * lines holding its one match. A save that would grow the document past the cap
 * is refused with the entries, so the bot consolidates instead of losing notes.
 */
export function editMemory(
  existing: string,
  fact: string,
  oldText = "",
  maxBytes = BOT_MEMORY_MAX_BYTES,
): MemoryEdit {
  const target = oldText.trim().replace(/\r\n/g, "\n");
  let content = existing;
  if (!target) {
    content = appendMemoryFact(existing, fact);
  } else {
    const current = existing.replace(/\r\n/g, "\n");
    // An entry is the line or lines a match touches, so repeats within one line count once.
    const starts = new Set<number>();
    for (let at = current.indexOf(target); at !== -1; at = current.indexOf(target, at + 1))
      starts.add(current.lastIndexOf("\n", at - 1) + 1);
    if (starts.size !== 1) {
      const firstLine = target.split("\n")[0]!;
      return {
        error:
          starts.size === 0
            ? "No entry contains old_text. Copy it exactly from one of these entries."
            : "old_text matches more than one entry. Quote more of the one to change.",
        entries: entriesOf(current).filter((line) => starts.size === 0 || line.includes(firstLine)),
      };
    }
    const index = current.indexOf(target);
    const start = [...starts][0]!;
    const lineEnd = current.indexOf("\n", index + target.length);
    const end = lineEnd === -1 ? current.length : lineEnd;
    const next = fact.trim().replace(/\r\n/g, "\n");
    content = next
      ? `${current.slice(0, start)}${next}${current.slice(end)}`
      : `${current.slice(0, start)}${current.slice(lineEnd === -1 ? end : end + 1)}`;
  }
  const bytes = byteLength(content);
  if (bytes > maxBytes && bytes > byteLength(existing)) {
    return {
      error: `Memory is full (${maxBytes} bytes). Make room by merging, shortening or removing entries with old_text, then save again.`,
      entries: entriesOf(existing),
    };
  }
  return { content };
}

function entriesOf(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
}
