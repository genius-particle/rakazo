import path from "node:path";
import type { AgentToolExecutionResult, ProcessEvent } from "@rakazo/adapter-kit";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { z } from "zod";
import type { HostComputerEnvironment } from "./host-computer-protocol.js";
import type {
  HostScreenAction,
  HostScreenActResult,
  HostScreenObservation,
} from "./host-screen.js";
import { HOST_SCREEN_MAX_ACTIONS, hostScreenAction } from "./host-screen.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import {
  IMAGE_READ_MAX_BYTES,
  imageMimeFromPath,
  imageToolResultFromBytes,
} from "./read-file-image.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_READ_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
} from "./user-computer-tools.js";
import { MAX_MODEL_FILE_BYTES, readFileRangeResult } from "./workspace-file-tools.js";

export {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_READ_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
};

/** Whether the run's owner has their desktop connected, or could connect one. */
export type UserComputerState = "connected" | "offline" | undefined;

const USER_COMPUTER_UNAVAILABLE =
  'The user\'s computer is not connected. If the task needs it, ask them to open the Rakazo desktop app and turn on "Let bots use this computer" in its settings.';

/**
 * Whose own computer this run may reach. Local deployment: any run whose user owns the bot,
 * including routines, webhooks, and channels. A run by someone else reaches no one's computer.
 */
export function userComputerOwner(input: {
  trigger: string;
  sourceRole: string | undefined;
  messagingChannelRun: boolean;
  runUserId: string;
  botUserId: string;
}): string | undefined {
  // 本地部署补丁：不限制渠道/触发源，仅保留 bot 归属校验。
  return input.runUserId === input.botUserId ? input.runUserId : undefined;
}

/**
 * Local deployment: the user's computer does not ask on every call. A block rule still denies it.
 */
export async function userComputerGate(
  _ctx: RunContext,
  blocked: boolean,
  _name: string,
  _args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  if (blocked) return "deny";
  // 本地部署补丁：不再逐次索取审批（Block 规则依然生效）。
  return "allow";
}

/** Resolve a file path on the user's computer: it must stay inside their home folder. */
export function userComputerFilePath(
  environment: HostComputerEnvironment,
  filePath: unknown,
): string {
  const paths = environment.platform === "win32" ? path.win32 : path.posix;
  const requested = typeof filePath === "string" ? filePath.trim() : "";
  if (!requested || requested === "~") {
    throw new Error("path must name a file inside the user's home folder");
  }
  const expanded = /^~[\\/]/.test(requested)
    ? paths.join(environment.home, requested.slice(2))
    : requested;
  const resolved = paths.resolve(environment.home, expanded);
  const relative = paths.relative(environment.home, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    throw new Error("path must be inside the user's home folder");
  }
  return resolved;
}

/** Fixed argv: the path is passed only in RAKAZO_READ_PATH, never interpolated into the command. */
export function readUserComputerFileArgv(platform: string): string[] {
  if (platform === "win32") {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p = $env:RAKAZO_READ_PATH; $m = [int64]$env:RAKAZO_READ_MAX; $i = Get-Item -LiteralPath $p; if ($i.PSIsContainer) { throw 'path must name a file' }; if ($i.Length -gt $m) { throw 'file is too large' }; [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))",
    ];
  }
  return [
    "sh",
    "-c",
    'p=$RAKAZO_READ_PATH; m=$RAKAZO_READ_MAX; if [ ! -f "$p" ]; then echo "file not found or unreadable" >&2; exit 2; fi; sz=$(wc -c < "$p" | tr -d "[:space:]"); if [ "$sz" -gt "$m" ]; then echo "file is too large" >&2; exit 3; fi; base64 < "$p"',
  ];
}

async function collectExecuteOutput(events: AsyncIterable<unknown>): Promise<{
  stdout: string;
  stderr: string;
  code: number | undefined;
}> {
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  for await (const event of events) {
    if (!event || typeof event !== "object") continue;
    const frame = event as { type?: unknown; data?: unknown; code?: unknown; heartbeat?: unknown };
    if (frame.heartbeat === true) continue;
    if (frame.type === "stdout" && typeof frame.data === "string") stdout += frame.data;
    else if (frame.type === "stderr" && typeof frame.data === "string") stderr += frame.data;
    else if (frame.type === "exit" && typeof frame.code === "number") code = frame.code;
  }
  return { stdout, stderr, code };
}

function decodeBase64File(stdout: string): Uint8Array | undefined {
  const packed = stdout.replace(/\s+/g, "");
  if (!packed) return new Uint8Array();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(packed) || packed.length % 4 !== 0) return undefined;
  return Buffer.from(packed, "base64");
}

export async function userComputerRead(ctx: RunContext, call: ToolCall) {
  const filePath = String(call.args.path ?? "").trim();
  if (!filePath)
    return call.finish({ error: "path must name a file inside the user's home folder" });
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  try {
    await lastValue(
      devices.request(
        owner,
        { method: "provision", botId: ctx.bot.id, runId: ctx.runId },
        signal,
        deviceId,
      ),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: ctx.bot.id, runId: ctx.runId },
        signal,
        deviceId,
      ),
    );
    let resolved: string;
    try {
      resolved = userComputerFilePath(environment, filePath);
    } catch (error) {
      return call.finish({
        error:
          error instanceof Error ? error.message : "path must be inside the user's home folder",
        path: filePath,
      });
    }
    const output = await collectExecuteOutput(
      devices.request(
        owner,
        {
          method: "execute",
          botId: ctx.bot.id,
          runId: ctx.runId,
          command: {
            argv: readUserComputerFileArgv(environment.platform),
            cwd: environment.home,
            env: {
              RAKAZO_READ_PATH: resolved,
              RAKAZO_READ_MAX: String(IMAGE_READ_MAX_BYTES),
            },
            timeoutMs: sandboxCommandTimeoutMs(),
          },
        },
        signal,
        deviceId,
      ),
    );
    if (output.code !== 0) {
      const reason = redactSecrets(
        (output.stderr || output.stdout || "file not found or unreadable").trim() ||
          "file not found or unreadable",
        ctx.secrets,
      );
      return call.finish({
        error: `The user's computer could not read the file: ${reason}`,
        path: filePath,
      });
    }
    const bytes = decodeBase64File(output.stdout);
    if (!bytes) {
      return call.finish({
        error: "The user's computer returned unreadable file data",
        path: filePath,
      });
    }
    if (imageMimeFromPath(filePath) || imageMimeFromPath(resolved)) {
      return call.finish(
        await imageToolResultFromBytes({
          path: filePath,
          bytes,
          acceptsImages: Boolean(ctx.computer.acceptsImages),
        }),
      );
    }
    if (bytes.byteLength > MAX_MODEL_FILE_BYTES) {
      return call.finish({
        error: "file is too large for model context",
        path: filePath,
        size: bytes.byteLength,
      });
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return call.finish({
        error: "file is not UTF-8 text and is not a png, jpeg, gif, or webp image",
        path: filePath,
      });
    }
    return call.finish(
      readFileRangeResult(filePath, redactSecrets(decoded, ctx.secrets), call.args),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "read failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish the read: ${reason}` });
  }
}

/** The working directory on the user's computer: their home or a folder inside it. */
export function userComputerCwd(environment: HostComputerEnvironment, cwd: unknown): string {
  const paths = environment.platform === "win32" ? path.win32 : path.posix;
  const requested = typeof cwd === "string" ? cwd.trim() : "";
  if (!requested || requested === "~") return environment.home;
  const expanded = /^~[\\/]/.test(requested)
    ? paths.join(environment.home, requested.slice(2))
    : requested;
  const resolved = paths.resolve(environment.home, expanded);
  const relative = paths.relative(environment.home, resolved);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    throw new Error("cwd must be inside the user's home folder; cd elsewhere within the command");
  return resolved;
}

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

/** Checked again at execution: the desktop can disconnect or be revoked after the offer. */
async function connectedUserComputer(ctx: RunContext) {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  const device = owner && devices ? await devices.connected(owner).catch(() => null) : null;
  return owner && devices && device ? { owner, devices, deviceId: device.deviceId } : undefined;
}

export async function userComputerShell(ctx: RunContext, call: ToolCall) {
  const { bot, runId } = ctx;
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  const command = String(call.args.command ?? "");
  try {
    // The device only executes for a provisioned bot; provisioning is idempotent.
    await lastValue(
      devices.request(owner, { method: "provision", botId: bot.id, runId }, signal, deviceId),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
        deviceId,
      ),
    );
    const observed = await observeShellCommand(
      devices.request<ProcessEvent>(
        owner,
        {
          method: "execute",
          botId: bot.id,
          runId,
          command: {
            argv: nativeShellCommandArgv(command, environment),
            cwd: userComputerCwd(environment, call.args.cwd),
            timeoutMs: sandboxCommandTimeoutMs(),
          },
        },
        signal,
        deviceId,
      ),
      { secrets: ctx.secrets },
    );
    if (!observed.completion) return call.finish(observed.result);
    void observed.completion.catch(() => undefined);
    const returned = await call.finish({ ...observed.result, notice: SHELL_STILL_RUNNING_NOTICE });
    if (isRunningShellCommand(returned)) call.observer?.onShellStillRunning?.(observed.completion);
    return returned;
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "command failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish the command: ${reason}` });
  }
}

const screenActions = z.array(hostScreenAction).min(1).max(HOST_SCREEN_MAX_ACTIONS);

export function userComputerObserve(ctx: RunContext, call: ToolCall) {
  const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
  return userComputerScreen(ctx, call, {
    method: "screenObserve",
    app: userComputerAppName(call.args.app),
    ...(query ? { query } : {}),
  });
}

export function userComputerAct(ctx: RunContext, call: ToolCall) {
  const actions = screenActions.safeParse(call.args.actions);
  if (!actions.success) {
    const issue = actions.error.issues[0];
    const where = issue?.path.length ? `actions.${issue.path.join(".")}: ` : "actions: ";
    return call.finish({ error: `${where}${issue?.message ?? "invalid"}` });
  }
  return userComputerScreen(ctx, call, {
    method: "screenAct",
    app: userComputerAppName(call.args.app),
    actions: actions.data,
  });
}

type ScreenRequest =
  | { method: "screenObserve"; app: string; query?: string }
  | { method: "screenAct"; app: string; actions: HostScreenAction[] };

/** The device gets the app name the approval card showed, never the raw argument. */
async function userComputerScreen(ctx: RunContext, call: ToolCall, request: ScreenRequest) {
  if (!request.app) return call.finish({ error: "app must name an app on the user's computer." });
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  try {
    const value = await lastValue(
      devices.request<HostScreenObservation | HostScreenActResult>(
        owner,
        { ...request, botId: ctx.bot.id, runId: ctx.runId },
        signal,
        deviceId,
      ),
    );
    if (request.method === "screenObserve")
      return call.finish(screenToolResult(ctx, value as HostScreenObservation, "observed"));
    const acted = value as HostScreenActResult;
    const total = request.actions.length;
    const note = `completed ${acted.completed} of ${total} action${total === 1 ? "" : "s"}${
      acted.error ? `; stopped: ${redactSecrets(acted.error, ctx.secrets)}` : ""
    }`;
    return call.finish(
      acted.observation
        ? screenToolResult(ctx, acted.observation, note)
        : { completed: acted.completed, ...(acted.error ? { error: note } : {}) },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "screen control failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish: ${reason}` });
  }
}

/** Only the window's name and size are stored; the rows and screenshot reach the model alone. */
function screenToolResult(
  ctx: RunContext,
  observation: HostScreenObservation,
  note: string,
): AgentToolExecutionResult {
  const image = ctx.computer.acceptsImages ? observation.image : undefined;
  const details = {
    app: observation.app,
    ...(observation.title ? { title: redactSecrets(observation.title, ctx.secrets) } : {}),
    ...(image ? { width: image.width, height: image.height } : {}),
  };
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}\n${JSON.stringify(details)}\n${redactSecrets(observation.tree, ctx.secrets)}`,
      },
      ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
    ],
    details,
  };
}
