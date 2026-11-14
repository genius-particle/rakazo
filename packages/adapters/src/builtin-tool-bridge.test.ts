import { describe, expect, it } from "vitest";
import {
  CORE_BUILTIN_TOOL_NAMES,
  FIND_TOOL,
  findTools,
  partitionTools,
  USE_TOOL,
} from "./builtin-tool-bridge.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { describeToolActivity } from "./pi-runtime-tools.js";
import { BUILTIN_AGENT_TOOL_NAMES, selectBuiltinToolsForRun } from "./run-tool-selection.js";

const ownerChat = selectBuiltinToolsForRun({
  graphicalToolsAllowed: false,
  groupId: null,
  trigger: "user",
  semanticMemoryEnabled: false,
  historyRetrievalEnabled: true,
  messagingChannelRun: false,
  fleetManagement: true,
  followUpFromUser: true,
});

const definitionBytes = (tools: typeof ownerChat) =>
  Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );

describe("built-in tool bridge", () => {
  it("lists a pinned tool set within a byte budget on an owner chat run", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "ask_user",
      "attach_file",
      "connect_app",
      "find_tool",
      "list_files",
      "message_user",
      "read_file",
      "read_history",
      "remember",
      "request_secret",
      "request_takeover",
      "run_subagent",
      "schedule_create",
      "schedule_list",
      "search_history",
      "shell",
      "skill_read",
      "update_bot",
      "update_preferences",
      "use_tool",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
    // request_secret carries the card and contact kinds; update_bot carries instructions paging;
    // the history tools point at files from earlier messages; a watch says it takes no other timing;
    // read_file takes a line range and says an image is read by path;
    // ask_user carries the content being decided about;
    // search_history lists earlier tool work by kind without a keyword.
    //
    // This number is an anti-bloat ratchet, not a model limit: it only says "do not grow".
    // The previous 33_080 line was already broken before this work (6fb3de4 measured 33_115).
    // This change adds 67 bytes: the message_user / message_bot / relay_to_bots /
    // handoff_to_bot descriptions now say a refused send posted nothing and must not be retried.
    //
    // Do not try to buy room back by sharing schedule_create's branch specs through $defs.
    // That was tried and dropped, not deferred. One function already builds all six branches,
    // so the copies exist only after JSON.stringify; keeping $ref on the wire hides the
    // "null is allowed" wording the model needs (release-watch-guidance asserts it), and
    // inlining the refs again saves no tokens. Measure definitionBytes before adding a tool or
    // a description; if it goes over, raise this line deliberately rather than trimming a
    // description another feature depends on.
    expect(definitionBytes(listed)).toBeLessThanOrEqual(33_200);
    expect(deferred.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["render_plot", "create_space", "generate_secret", "scratchpad_add"]),
    );
  });

  it("names only real built-ins as core", () => {
    for (const name of CORE_BUILTIN_TOOL_NAMES) expect(BUILTIN_AGENT_TOOL_NAMES).toContain(name);
  });

  it("lists every tool when none is deferred", () => {
    const core = ownerChat.filter((tool) => CORE_BUILTIN_TOOL_NAMES.has(tool.name));
    expect(partitionTools(core)).toEqual({ listed: core, deferred: [] });
  });

  it("names deferred tools by area in find_tool, without schemas", () => {
    const { listed, deferred } = partitionTools(ownerChat);
    const description = listed.find((tool) => tool.name === FIND_TOOL)!.description;
    for (const tool of deferred) expect(description).toContain(tool.name);
    expect(description).toContain("secrets:\n");
    expect(description).not.toContain("inputSchema");
    expect(listed.some((tool) => tool.name === USE_TOOL)).toBe(true);
  });

  it("finds exact names and ranks a query over names, descriptions and parameters", () => {
    const { deferred } = partitionTools(ownerChat);
    const plot = findTools(deferred, { names: ["render_plot", "shell", "nope"] });
    expect(plot.tools.map((tool) => tool.name)).toEqual(["render_plot"]);
    expect(plot.tools[0]!.inputSchema).toEqual(
      deferred.find((tool) => tool.name === "render_plot")!.inputSchema,
    );
    expect(plot.unknown).toEqual(["shell", "nope"]);

    const names = (query: string) => findTools(deferred, { query }).tools.map((tool) => tool.name);
    expect(names("chart")).toContain("render_plot");
    expect(names("new space")[0]).toBe("create_space");
    expect(names("generate password")[0]).toBe("generate_secret");
    expect(names("scratchpad add")[0]).toBe("scratchpad_add");
    expect(names("scratchpad").length).toBe(3);
    expect(findTools(deferred, { query: "zzzz" })).toMatchObject({
      tools: [],
      hint: expect.any(String),
    });
  });

  it("never finds a tool the bot turned off", () => {
    const { listed, deferred } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        disabledBuiltinTools: ["render_plot"],
      }),
    );
    expect(findTools(deferred, { names: ["render_plot"] })).toMatchObject({
      tools: [],
      unknown: ["render_plot"],
    });
    expect(listed.find((tool) => tool.name === FIND_TOOL)!.description).not.toContain(
      "render_plot",
    );
  });

  it("shows the real tool as activity", () => {
    expect(
      describeToolActivity(USE_TOOL, { name: "create_space", arguments: { name: "Finance" } }),
    ).toBe("Creating space: Finance");
  });
});

// The six exclusive timing branches must stay honest: every method validates on its own,
// blank leftovers still pass, and a real value in a second method still fails.
describe("schedule_create timing branches", () => {
  const schedule = ownerChat.find((tool) => tool.name === "schedule_create")!;
  const check = (args: Record<string, unknown>) =>
    parseConnectorToolArgs(schedule.inputSchema, args);
  const base = { name: "Morning digest", prompt: "Send the list each morning." };

  it("accepts each timing method", () => {
    expect(() => check({ ...base, cron: "0 9 * * *" })).not.toThrow();
    expect(() => check({ ...base, every: 2, unit: "hours" })).not.toThrow();
    expect(() => check({ ...base, runAt: "2026-11-20T09:00" })).not.toThrow();
    expect(() => check({ ...base, delayMinutes: 10 })).not.toThrow();
    expect(() => check({ ...base, delaySeconds: 30 })).not.toThrow();
    expect(() =>
      check({ ...base, watch: { kind: "files", paths: ["/tmp/reports"] } }),
    ).not.toThrow();
  });

  it("ignores null and blank leftovers in the other timing fields", () => {
    expect(() =>
      check({ ...base, cron: "0 9 * * *", every: null, unit: "", runAt: "", watch: null }),
    ).not.toThrow();
  });

  it("rejects a real value in a second timing method", () => {
    expect(() => check({ ...base, cron: "0 9 * * *", every: 2, unit: "hours" })).toThrow();
  });

  it("still rejects a property the branch does not declare", () => {
    expect(() => check({ ...base, cron: "0 9 * * *", nope: true })).toThrow();
  });
});
