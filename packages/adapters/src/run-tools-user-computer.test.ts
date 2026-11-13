import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  readUserComputerFileArgv,
  userComputerCwd,
  userComputerFilePath,
  userComputerGate,
  userComputerOwner,
  userComputerRead,
  userComputerShell,
} from "./run-tools-user-computer.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

const environment = { platform: "darwin", home: "/Users/fake", shell: "/bin/zsh" };

function setup(execute: (signal: AbortSignal) => AsyncIterable<unknown>, secrets: string[] = []) {
  const controller = new AbortController();
  const requests: HostComputerRequest[] = [];
  const signals: AbortSignal[] = [];
  const deviceIds: (string | undefined)[] = [];
  const gateway: UserDeviceGateway = {
    connected: async () => ({ deviceId: "device-1", name: "Laptop", platform: "darwin" }),
    pairedSince: async () => new Date(0),
    async *request<T>(
      _userId: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      requests.push(request);
      deviceIds.push(deviceId);
      signals.push(signal);
      if (request.method === "provision") yield {} as T;
      else if (request.method === "environment") yield environment as T;
      else yield* execute(signal) as AsyncIterable<T>;
    },
  };
  const ctx = {
    deps: { userDevices: gateway },
    bot: { id: "bot-1" },
    runId: "run-1",
    source: { userComputerOwner: "user-1" },
    context: { signal: controller.signal },
    secrets,
  } as unknown as RunContext;
  const onShellStillRunning = vi.fn();
  const call = (args: Record<string, unknown>) =>
    ({
      name: "user_computer_shell",
      args,
      observer: { onShellStillRunning },
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, controller, requests, signals, deviceIds, onShellStillRunning };
}

describe("userComputerGate", () => {
  it("allows the user's computer unless the call is blocked", async () => {
    const findMany = vi.fn();
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    await expect(
      userComputerGate(ctx, false, "user_computer_observe", { app: "mail" }),
    ).resolves.toBe("allow");
    await expect(
      userComputerGate(ctx, false, "user_computer_read", { path: "Pictures/shot.png" }),
    ).resolves.toBe("allow");
    expect(findMany).not.toHaveBeenCalled();
    await expect(
      userComputerGate(ctx, true, "user_computer_read", { path: "Pictures/shot.png" }),
    ).resolves.toBe("deny");
  });
});

describe("userComputerOwner", () => {
  const own = {
    trigger: "user",
    sourceRole: "user",
    messagingChannelRun: false,
    runUserId: "user-1",
    botUserId: "user-1",
  };

  it("is the bot owner for any trigger when this run's user owns the bot", () => {
    expect(userComputerOwner(own)).toBe("user-1");
    for (const change of [
      { trigger: "follow_up" },
      { trigger: "routine" },
      { trigger: "webhook" },
      { trigger: "messaging" },
      { trigger: "call_end" },
      { sourceRole: "bot" as const },
      { sourceRole: undefined },
      { messagingChannelRun: true },
    ]) {
      expect(userComputerOwner({ ...own, ...change })).toBe("user-1");
    }
  });

  it("is nobody when the run user does not own the bot", () => {
    expect(userComputerOwner({ ...own, runUserId: "user-2" })).toBeUndefined();
  });
});

describe("userComputerCwd", () => {
  it("defaults to home and resolves relative and ~ paths against it", () => {
    expect(userComputerCwd(environment, undefined)).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~")).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "/Users/fake/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "..cache")).toBe("/Users/fake/..cache");
    expect(() => userComputerCwd(environment, "/tmp")).toThrow("inside the user's home folder");
    expect(() => userComputerCwd(environment, "../other")).toThrow("inside the user's home folder");
    expect(
      userComputerCwd({ platform: "win32", home: "C:\\Users\\fake", shell: "pwsh" }, "code"),
    ).toBe("C:\\Users\\fake\\code");
  });
});

describe("userComputerShell", () => {
  it("streams the command's redacted output from the user's shell", async () => {
    const { ctx, call, requests, deviceIds } = setup(
      async function* () {
        yield { type: "stdout", data: "token=sk-fake-secret\n" };
        yield { type: "stderr", data: "warning\n" };
        yield { type: "exit", code: 2 };
      },
      ["sk-fake-secret"],
    );
    const result = (await userComputerShell(ctx, call({ command: "cat .env", cwd: "app" }))) as {
      stdout: string;
      stderr: string;
      code: number;
    };
    expect(result.stdout).not.toContain("sk-fake-secret");
    expect(result).toMatchObject({ stderr: "warning\n", code: 2 });
    expect(deviceIds).toEqual(["device-1", "device-1", "device-1"]);
    expect(requests).toEqual([
      { method: "provision", botId: "bot-1", runId: "run-1" },
      { method: "environment", botId: "bot-1", runId: "run-1" },
      {
        method: "execute",
        botId: "bot-1",
        runId: "run-1",
        command: expect.objectContaining({
          argv: ["/bin/zsh", "-lc", "cat .env"],
          cwd: "/Users/fake/app",
        }),
      },
    ]);
  });

  it("returns a quiet sign-in prompt early and keeps collecting its output", async () => {
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.useFakeTimers();
    try {
      const { ctx, call, onShellStillRunning } = setup(async function* () {
        yield { type: "stdout", data: "Enter code ABCD-1234 at https://example.com/device\n" };
        await exited;
        yield { type: "exit", code: 0 };
      });
      const pending = userComputerShell(ctx, call({ command: "gh auth login" }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({
        stdout: "Enter code ABCD-1234 at https://example.com/device\n",
        running: true,
      });
      expect(onShellStillRunning).toHaveBeenCalledOnce();
      finish();
      await expect(onShellStillRunning.mock.calls[0]![0]).resolves.toMatchObject({ code: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a device that drops mid-command as an error result", async () => {
    const { ctx, call } = setup(async function* () {
      yield* [];
      throw new Error("Device disconnected");
    });
    expect(await userComputerShell(ctx, call({ command: "ls" }))).toEqual({
      error: "The user's computer did not finish the command: Device disconnected",
    });
  });

  it("passes the run's abort to the device and rethrows it", async () => {
    const { ctx, call, controller, signals } = setup(async function* (signal) {
      yield* [];
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    });
    const pending = userComputerShell(ctx, call({ command: "sleep 100" }));
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("userComputerFilePath", () => {
  it("resolves paths inside the user's home and refuses escapes", () => {
    expect(userComputerFilePath(environment, "Pictures/shot.png")).toBe(
      "/Users/fake/Pictures/shot.png",
    );
    expect(userComputerFilePath(environment, "~/Pictures/shot.png")).toBe(
      "/Users/fake/Pictures/shot.png",
    );
    expect(userComputerFilePath(environment, "/Users/fake/Pictures/shot.png")).toBe(
      "/Users/fake/Pictures/shot.png",
    );
    expect(() => userComputerFilePath(environment, "/tmp/shot.png")).toThrow(
      "inside the user's home folder",
    );
    expect(() => userComputerFilePath(environment, "../other.png")).toThrow(
      "inside the user's home folder",
    );
    expect(() => userComputerFilePath(environment, "~")).toThrow("path must name a file");
    expect(() => userComputerFilePath(environment, "")).toThrow("path must name a file");
  });

  it("uses Windows path rules when the desktop is Windows", () => {
    const win = { platform: "win32", home: "C:\\Users\\fake", shell: "powershell.exe" };
    expect(userComputerFilePath(win, "Pictures\\shot.png")).toBe(
      "C:\\Users\\fake\\Pictures\\shot.png",
    );
    expect(userComputerFilePath(win, "C:\\Users\\fake\\Pictures\\shot.png")).toBe(
      "C:\\Users\\fake\\Pictures\\shot.png",
    );
    expect(() => userComputerFilePath(win, "C:\\Windows\\shot.png")).toThrow(
      "inside the user's home folder",
    );
  });
});

describe("userComputerRead", () => {
  it("feeds a user-computer image to the model without opening a window", async () => {
    const png = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    async function* execute() {
      yield { type: "stdout", data: png.toString("base64") };
      yield { type: "exit", code: 0 };
    }
    const { ctx, call, requests } = setup(execute);
    (ctx as { computer: { acceptsImages: boolean } }).computer = { acceptsImages: true };
    const result = await userComputerRead(ctx, call({ path: "Pictures/shot.png" }));
    expect(result).toMatchObject({
      kind: "agent_tool_result",
      details: { path: "Pictures/shot.png", width: 20, height: 10, mimeType: "image/png" },
    });
    const executed = requests.find((request) => request.method === "execute");
    expect(executed?.method).toBe("execute");
    if (executed && executed.method === "execute") {
      expect(executed.command.argv).toEqual(readUserComputerFileArgv("darwin"));
      expect(executed.command.env).toMatchObject({
        RAKAZO_READ_PATH: "/Users/fake/Pictures/shot.png",
      });
      expect(executed.command.argv.join(" ")).not.toContain("shot.png");
    }
  });

  it("refuses a path outside the user's home without running a command", async () => {
    const { ctx, call, requests } = setup(async function* () {
      yield { type: "exit", code: 0 };
    });
    (ctx as { computer: { acceptsImages: boolean } }).computer = { acceptsImages: true };
    const result = await userComputerRead(ctx, call({ path: "/tmp/secret.png" }));
    expect(result).toMatchObject({
      error: "path must be inside the user's home folder",
      path: "/tmp/secret.png",
    });
    expect(requests.some((request) => request.method === "execute")).toBe(false);
  });

  it("says when a non-image file is not UTF-8 text", async () => {
    async function* execute() {
      yield { type: "stdout", data: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") };
      yield { type: "exit", code: 0 };
    }
    const { ctx, call } = setup(execute);
    (ctx as { computer: { acceptsImages: boolean } }).computer = { acceptsImages: true };
    const result = await userComputerRead(ctx, call({ path: "notes/blob.bin" }));
    expect(result).toEqual({
      error: "file is not UTF-8 text and is not a png, jpeg, gif, or webp image",
      path: "notes/blob.bin",
    });
  });
});
