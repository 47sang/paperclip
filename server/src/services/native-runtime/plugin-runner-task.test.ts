import { describe, expect, it, vi } from "vitest";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));

function launchSpec(connection: NonNullable<RunnerProcessLaunchSpec["nativeRunner"]>["connection"]): RunnerProcessLaunchSpec {
  return { command: "unused", args: [], cwd: "/unused", environment: {}, nativeRunner: {
    connection, identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
      normalizedSessionId: "session", turnId: "turn", itemId: "item" }, ticket: "synthetic-ticket",
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
  it("reconciles a lost submit reply without launching another attempt", async () => {
    const { task } = provider();
    task.mockRejectedValueOnce(new Error("lost submit reply"));
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      runnerExecutable: "/runner", prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec(registration.connection));
    try {
      registration.activate(); await registration.ready();
      expect(task.mock.calls.filter(([operation]) => operation.kind === "submit")).toHaveLength(1);
      expect(() => owner.launcher(launchSpec(registration.connection))).toThrow("new task lease");
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
      expect(task.mock.calls.filter(([operation]) => operation.kind === "complete")).toHaveLength(1);
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });

  it("retains task grants when checkpoint export fails after route release", async () => {
    const { task } = provider();
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", runnerExecutable: "/runner",
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
      runnerExecutable: "/runner", prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
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
      runnerExecutable: "/runner", prepare: () => prepared, checkpoint: async () => {}, pollMs: 1 });
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
      runnerExecutable: "/runner", prepare: async () => {}, checkpoint: async () => {}, pollMs: 1 });
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
