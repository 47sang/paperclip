import { describe, expect, it, vi } from "vitest";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { configuredEnvironment, configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";
import { createPluginRunnerTaskOwner, pluginRunnerEnvironment } from "./plugin-runner-task.js";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));

function launchSpec(connection: NonNullable<RunnerProcessLaunchSpec["nativeRunner"]>["connection"]): RunnerProcessLaunchSpec {
  return { command: "unused", args: [], cwd: "/unused", environment: {}, nativeRunner: {
    connection, identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
      normalizedSessionId: "session", turnId: "turn", itemId: "item" }, ticket: "synthetic-ticket",
    diagnosticsDirectory: "/controller/private/diagnostics",
    stateDirectory: "/state", runnerVersion: "fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
    maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  } };
}

function provider() {
  let stopped = false;
  const task = vi.fn(async (operation: any): Promise<unknown> => {
    if (operation.kind === "stop") stopped = true;
    if (operation.kind === "status") return { kind: "status", taskId: "task", phase: stopped ? "cancelled" : "running", executionStopped: stopped };
    if (operation.kind === "connection") return { kind: "connection", taskId: "task", endpoint: {
      kind: "authenticated_websocket", websocketUrl: "wss://fixture.example.test/connect", generation: "fixture", secretHeaders: [],
    } };
    return { kind: "accepted", taskId: "task" };
  });
  return { task };
}

describe("plugin native Runner ownership", () => {
  it("removes discarded controller paths from the configured environment projection", () => {
    const input = configuredEnvironmentProjection({ OPENCODE_CONFIG_DIR: "/controller/config", RETAINED_SETTING: "configured" });
    const providerSettings: Record<string, string>[] = [{}, { OPENCODE_CONFIG_DIR: "provider-config" }];
    for (const provided of providerSettings) {
      const environment = pluginRunnerEnvironment(input, provided);
      expect(configuredEnvironment(environment)).toEqual({ RETAINED_SETTING: "configured", PAPERCLIP_CONFIGURED_ENV_KEYS: '["RETAINED_SETTING"]' });
      expect(environment.OPENCODE_CONFIG_DIR).toBe(provided.OPENCODE_CONFIG_DIR);
    }
  });
  it("keeps selected execution inputs authoritative while replacing controller paths", () => {
    expect(pluginRunnerEnvironment({ OPENAI_API_KEY: "selected", XAI_API_KEY: "", PATH: "/controller/bin", HOME: "/controller/home", OPENCODE_CONFIG_DIR: "" },
      { OPENAI_API_KEY: "default", XAI_API_KEY: "default", PATH: "provider-bin", HOME: "provider-home", OPENCODE_CONFIG_DIR: "provider-config" }))
      .toEqual({ OPENAI_API_KEY: "selected", XAI_API_KEY: "", PATH: "provider-bin", HOME: "provider-home", OPENCODE_CONFIG_DIR: "provider-config" });
  });
  it("exposes connection failure before activation and forwards late recovery exhaustion", async () => {
    const { task } = provider();
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), failure, close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 7777, listenPath: "/provider-listener" },
      prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const observed = registration.failure.catch(error => error);
    const handle = owner.launcher(launchSpec(registration.connection));
    registration.activate(); await registration.ready();
    const error = new Error("runner ingress recovery exhausted"); fail(error);
    expect(await observed).toBe(error);
    expect(task.mock.calls.find(([op]) => op.kind === "stop")).toBeUndefined();
    await registration.release(); await registration.checkpoint("settled"); await handle.completion;
  });
  it("reconciles a lost submit reply without launching another attempt", async () => {
    const { task } = provider();
    task.mockRejectedValueOnce(new Error("lost submit reply"));
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 7777, listenPath: "/provider-listener" } as const, prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec(registration.connection));
    try {
      registration.activate(); await registration.ready();
      expect(task.mock.calls.filter(([operation]) => operation.kind === "submit")).toHaveLength(1);
      expect(task.mock.calls.find(([operation]) => operation.kind === "submit")?.[0].launch).not.toHaveProperty("diagnosticsDirectory");
      expect(() => owner.launcher(launchSpec(registration.connection))).toThrow("new task lease");
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
      expect(task.mock.calls.filter(([operation]) => operation.kind === "complete")).toHaveLength(1);
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });

  it("retains task grants when checkpoint export fails after route release", async () => {
    const { task } = provider();
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 7777, listenPath: "/provider-listener" },
      prepare: async () => {}, checkpoint: async () => { throw new Error("export failed"); }, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec(registration.connection));
    registration.activate(); await registration.ready(); await registration.release();
    expect(task.mock.calls.some(([operation]) => operation.kind === "complete")).toBe(false);
    await expect(registration.checkpoint("settled")).rejects.toThrow("export failed");
    await process.completion;
    expect(task.mock.calls.some(([operation]) => operation.kind === "complete")).toBe(false);
  });

  it("detaches a controller without stopping its durable task", async () => {
    const { task } = provider();
    const close = vi.fn(async () => {});
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 7777, listenPath: "/provider-listener" } as const, prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    owner.launcher(launchSpec(registration.connection));
    registration.activate(); await registration.ready(); await registration.release("detach");
    expect(close).toHaveBeenCalledOnce();
    expect(task.mock.calls.some(([operation]) => operation.kind === "stop" || operation.kind === "complete")).toBe(false);
  });

  it("prevents a late submission after cancellation during asset preparation", async () => {
    let finish!: () => void;
    const prepared = new Promise<void>(resolve => { finish = resolve; });
    const { task } = provider();
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 7777, listenPath: "/provider-listener" } as const, prepare: () => prepared, checkpoint: async () => {}, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec(registration.connection));
    registration.activate();
    await registration.release(); finish();
    await expect(process.completion).resolves.toMatchObject({ code: 1 });
    await expect(registration.ready()).rejects.toThrow("cancelled");
    expect(task).not.toHaveBeenCalled();
  });

  it("does not connect a released or aborted startup to the PRP authority", async () => {
    const { task } = provider();
    ingress.connect.mockClear();
    const controller = new AbortController(); controller.abort();
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 7777, listenPath: "/provider-listener" } as const, prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
    const registration = await owner.registration({} as never, "run", controller.signal);
    const process = owner.launcher(launchSpec(registration.connection));
    try {
      registration.activate();
      await expect(registration.ready()).rejects.toThrow("cancelled");
      expect(task.mock.calls.filter(([operation]) => operation.kind === "connection")).toHaveLength(0);
      expect(ingress.connect).not.toHaveBeenCalled();
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });
});
