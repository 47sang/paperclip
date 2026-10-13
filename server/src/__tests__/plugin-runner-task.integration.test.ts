import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, projects } from "@paperclipai/db";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { createRequest, parseMessage, serializeMessage, isJsonRpcSuccessResponse, isJsonRpcErrorResponse } from "../../../packages/plugins/sdk/src/protocol.js";
import type { PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import { remoteExecutionHasStopped } from "../services/remote-execution-termination.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { createPluginRunnerTaskOwner } from "../services/native-runtime/plugin-runner-task.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));
const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

/** Real SDK serialization and dispatch with synthetic provider resources. */
function workerHarness(plugin: ReturnType<typeof definePlugin>, manifest: PaperclipPluginManifestV1) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const host = startWorkerRpcHost({ plugin, stdin, stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0, buffer = "";
  stdout.on("data", chunk => {
    buffer += String(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = parseMessage(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (!isJsonRpcSuccessResponse(message) && !isJsonRpcErrorResponse(message)) continue;
      const waiter = pending.get(Number(message.id));
      pending.delete(Number(message.id));
      if (isJsonRpcSuccessResponse(message)) waiter?.resolve(message.result);
      else waiter?.reject(new Error(message.error.message));
    }
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    stdin.write(serializeMessage(createRequest(method as never, params as never, id)));
  });
  return { call, stop: () => host.stop(), initialize: () => call("initialize", {
    manifest, config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" }, apiVersion: 1,
  }) };
}

databaseSuite("Core plugin Runner task lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-runner-task");
    stopDb = started.stop; db = createDb(started.connectionString);
  });
  afterAll(async () => { await stopDb?.(); });

  it("uses an acquired lease through SDK RPC, native dispatch, connection, stop proof and release", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), projectId = randomUUID();
    const manifest: PaperclipPluginManifestV1 = {
      id: "test.runner-tasks", apiVersion: 1, version: "1.0.0", displayName: "Runner tasks",
      description: "Synthetic task provider", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
      environmentDrivers: [{ driverKey: "tasks", displayName: "Tasks", supportsTasks: true, configSchema: { type: "object" } }],
    };
    await db.insert(companies).values({ id: companyId, name: "Fixture", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture", status: "active" });
    const [environment] = await db.insert(environments).values({ id: environmentId, name: "Fixture", driver: "plugin", status: "active",
      config: { pluginKey: manifest.id, driverKey: "tasks", driverConfig: {} } }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@test/runner-tasks",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], manifestJson: manifest, status: "ready" });
    const calls: PluginEnvironmentTaskOperation[] = [];
    let executionStopped = false, stopRequested = false, acquisition = 0;
    const released = vi.fn(), complete = vi.fn();
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentAcquireLease() { return { providerLeaseId: `attempt:fixture.${++acquisition}`, metadata: { remoteCwd: "/workspace" } }; },
      async onEnvironmentReleaseLease() { released(); },
      async onEnvironmentTask(params) {
        calls.push(params.operation);
        switch (params.operation.kind) {
          case "describe": return { kind: "description", taskId: params.taskId,
            runner: { executable: "/runner", version: "fixture", digest: `sha256:${"a".repeat(64)}` },
            filesystemRoot: "/state", codexCommand: "/codex" };
          case "read_file": return { kind: "file", taskId: params.taskId, base64: "" };
          case "checkpoint": return { kind: "checkpoint", taskId: params.taskId, state: {} };
          case "submit": stopRequested = false; executionStopped = false; return { kind: "accepted", taskId: params.taskId };
          case "status": return { kind: "status", taskId: params.taskId, phase: stopRequested ? "cancelled" : "running", executionStopped };
          case "connection": return { kind: "connection", taskId: params.taskId, endpoint: {
            kind: "authenticated_websocket", websocketUrl: "wss://runner.example.test/connect", generation: "fixture",
            secretHeaders: [{ name: "Authorization", value: "Bearer synthetic-fixture" }],
          } };
          case "stop": stopRequested = true; return { kind: "accepted", taskId: params.taskId };
          case "complete": complete(); return { kind: "accepted", taskId: params.taskId };
        }
      },
    });
    const harness = workerHarness(plugin, manifest);
    const { supportedMethods } = await harness.initialize();
    const workers = { isRunning: () => true, getWorker: () => ({ supportedMethods }),
      call: (_id: string, method: string, params: unknown) => harness.call(method, params) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });
    const acquired = await orchestrator.acquireForRun({ companyId, selectedEnvironmentId: environmentId, localEnvironmentId: randomUUID(),
      agentId, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null,
      executionWorkspaceSettings: null, adapterType: "paperclip_runner" });
    const realization = await orchestrator.realizeForRun({ companyId, environment: acquired.environment, lease: acquired.lease,
      adapterType: "paperclip_runner", issueId: null, heartbeatRunId: runId,
      executionWorkspace: { baseCwd: "/local/project", cwd: "/local/project", source: "project_primary", projectId,
        workspaceId: null, repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, worktreePath: null,
        warnings: [], created: false, branchCreatedByRuntime: false },
      effectiveExecutionWorkspaceMode: null, persistedExecutionWorkspace: null });
    const target = realization.executionTarget;
    expect(target).toMatchObject({ kind: "remote", transport: "sandbox", remoteCwd: "/workspace", leaseId: acquired.lease.id });
    if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runnerTask) throw new Error("Missing plugin target");
    expect(target.runner).toBeUndefined();
    const onDispatched = vi.fn(), checkpoint = vi.fn(async () => {}), close = vi.fn(async () => {});
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close });
    const owner = createPluginRunnerTaskOwner({ task: target.runnerTask, projectIds: target.runnerTaskProjectIds ?? [], harness: "codex",
      runnerExecutable: "/runner/paperclip-runnerd", prepare: async () => {},
      assets: () => [{ sourcePath: "/core/context", targetPath: "/runner/context" }], checkpoint, onDispatched, pollMs: 1 });
    const registration = await owner.registration({} as never, runId);
    const handle = owner.launcher({ command: "ignored", args: [], cwd: "/ignored", environment: { OPENAI_API_KEY: "synthetic-launch-key" },
      nativeRunner: { identity: { runnerInstanceId: randomUUID(), environmentLeaseId: acquired.lease.id, runId,
        normalizedSessionId: randomUUID(), turnId: "turn", itemId: "item" }, ticket: "synthetic-bootstrap-ticket",
        connection: registration.connection, stateDirectory: "/runner/state", runnerVersion: "fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } });
    let settled = false;
    void handle.completion.then(() => { settled = true; });
    try {
      registration.activate(); await registration.ready();
      expect(onDispatched).toHaveBeenCalledOnce();
      expect(ingress.connect).toHaveBeenCalledWith(expect.objectContaining({ endpoint: expect.objectContaining({ websocketUrl: "wss://runner.example.test/connect" }) }));
      const submit = calls.find(operation => operation.kind === "submit");
      expect(submit).toMatchObject({ kind: "submit", projectIds: [projectId], runner: { leaseId: acquired.lease.id, runId },
        launch: { runnerExecutable: "/runner/paperclip-runnerd", assets: [{ sourcePath: "/core/context", targetPath: "/runner/context" }], environment: { OPENAI_API_KEY: "synthetic-launch-key" } } });
      const [saved] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.lease.id));
      expect(saved.metadata?.runnerTaskDispatched).toBe(true);
      expect(JSON.stringify(saved.metadata)).not.toMatch(/synthetic-launch-key|synthetic-bootstrap-ticket|synthetic-fixture/);
      await expect(runtime.task({ companyId: randomUUID(), leaseId: acquired.lease.id, operation: { kind: "stop" } })).rejects.toThrow("lease unavailable");
      const before = calls.filter(value => value.kind === "submit").length;
      await expect(runtime.task({ companyId, leaseId: acquired.lease.id, operation: { ...submit!, projectIds: [randomUUID()] } as never })).rejects.toThrow("project unavailable");
      expect(calls.filter(value => value.kind === "submit")).toHaveLength(before);
      handle.child.kill("SIGTERM");
      await vi.waitFor(() => expect(stopRequested).toBe(true));
      await delay(10); expect(settled).toBe(false);
      executionStopped = true; await handle.completion;
      await registration.checkpoint("settled"); await registration.release();
      expect(checkpoint).toHaveBeenCalledWith("settled"); expect(complete).toHaveBeenCalledOnce();
      await runtime.releaseRunLeases(runId, "released");
      expect(released).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(true);

      // A controller that dies after dispatch leaves only the lease marker.
      const second = await runtime.acquireRunLease({ companyId, environment: environment as never, agentId,
        issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null, adapterType: "paperclip_runner" });
      if (submit?.kind !== "submit") throw new Error("Missing submit fixture");
      await runtime.task({ companyId, leaseId: second.lease.id,
        operation: { ...submit, runner: { ...submit.runner, leaseId: second.lease.id } } });
      await runtime.task({ companyId, leaseId: second.lease.id, operation: { kind: "complete" } });
      const errors = vi.fn();
      await runtime.releaseRunLeases(runId, "released", errors);
      expect(errors).toHaveBeenCalledOnce();
      expect(released).toHaveBeenCalledOnce(); // No release while termination is unknown.
      const [pending] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, second.lease.id));
      expect(pending).toMatchObject({ status: "pending_cleanup", metadata: { runnerTaskDispatched: true } });
      await db.delete(environments).where(eq(environments.id, environmentId));
      executionStopped = true;
      const sweep = await heartbeatService(db, { environmentRuntime: runtime, pluginWorkerManager: workers }).sweepPendingCleanupLeases();
      expect(sweep.destroyed).toBe(1);
      const [cleaned] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, second.lease.id));
      expect(cleaned).toMatchObject({ status: "expired", cleanupStatus: "success", environmentId: null,
        metadata: { runnerTaskDispatched: false, remoteExecutionTermination: { state: "stopped" } } });
    } finally { executionStopped = true; handle.child.kill(); await handle.completion.catch(() => {}); harness.stop(); }
  });
});
