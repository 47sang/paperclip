import { setTimeout as delay } from "node:timers/promises";
import { environmentTaskOperationSchema, environmentTaskResultSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { PAPERCLIP_RUNNER_INGRESS_PORT, PAPERCLIP_RUNNER_CONNECT_PATH_PREFIX } from "@paperclipai/adapter-utils/runner-connectivity";
import { RUNNER_PRP_PROTOCOL_MIN, RUNNER_PRP_PROTOCOL_MAX, type RunnerProcessHandle, type RunnerProcessLaunchSpec,
  type DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";

/** Adapts a lease-bound task provider to the existing native process owner.
 * No provider pid is treated as a local pid. Only executionStopped settles it.
 */
export function createPluginRunnerTaskOwner(input: {
  task: (operation: unknown) => Promise<unknown>;
  projectIds: readonly string[];
  runnerExecutable: string;
  harness: string;
  prepare: () => Promise<void>;
  assets?: () => { sourcePath: string; targetPath: string }[];
  checkpoint: (settlement: "settled" | "unsettled") => Promise<void>;
  onDispatched?: () => Promise<void> | void;
  pollMs?: number;
}) {
  const pollMs = input.pollMs ?? 500;
  let launched = false;
  let stopRequested = false;
  let released = false;
  let submitted = false;
  let detached = false;
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
  const running = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  void running.catch(() => undefined);
  const call = async (operation: PluginEnvironmentTaskOperation) => {
    const result = environmentTaskResultSchema.parse(await input.task(operation));
    if (result.kind !== (operation.kind === "read_file" ? "file" : operation.kind === "describe" ? "description" : ["status", "connection", "checkpoint"].includes(operation.kind) ? operation.kind : "accepted")) {
      throw new Error("Plugin Runner returned an invalid operation result");
    }
    return result;
  };
  const stopAndConfirm = async () => {
    await call({ kind: "stop" });
    const deadline = Date.now() + 15_000;
    do {
      const state = await call({ kind: "status" });
      if (state.kind === "status" && state.executionStopped === true) return;
      await delay(pollMs);
    } while (Date.now() < deadline);
    throw new Error("Plugin Runner termination is unconfirmed; retain the lease for cleanup");
  };
  const launcher = (spec: RunnerProcessLaunchSpec): RunnerProcessHandle => {
    if (launched || released) throw new Error("Plugin Runner replacement requires a new task lease");
    const native = spec.nativeRunner;
    if (!native || native.connection?.mode !== "listen" || native.lifecyclePolicy?.mode !== "per_turn") {
      throw new Error("Plugin Runner requires a structured per-turn native launch");
    }
    const operation = environmentTaskOperationSchema.parse({
      kind: "submit", projectIds: [...input.projectIds], bootstrapTicket: native.ticket,
      runner: { protocolMin: RUNNER_PRP_PROTOCOL_MIN, protocolMax: RUNNER_PRP_PROTOCOL_MAX,
        harness: input.harness,
        runnerId: native.identity.runnerInstanceId, leaseId: native.identity.environmentLeaseId,
        runId: native.identity.runId, sessionId: native.identity.normalizedSessionId,
        turnId: native.identity.turnId, itemId: native.identity.itemId },
      launch: { stateDirectory: native.stateDirectory, runnerExecutable: input.runnerExecutable,
        runnerVersion: native.runnerVersion, runnerDigest: native.runnerDigest, connection: native.connection,
        maxOutboxBytes: native.maxOutboxBytes, p0ReserveBytes: native.p0ReserveBytes,
        maxRuntimeMs: native.maxRuntimeMs, maxLifetimeMs: native.maxLifetimeMs,
        reconnectGraceMs: native.reconnectGraceMs, lifecyclePolicy: native.lifecyclePolicy,
        acpxLaunchProfile: native.acpxLaunchProfile, opencodeLaunchProfile: native.opencodeLaunchProfile,
        diagnosticsDirectory: native.diagnosticsDirectory,
        environment: Object.fromEntries(Object.entries(spec.environment).filter(([key, value]) =>
          value !== undefined && key !== "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET")),
      },
    });
    launched = true;
    const child: RunnerProcessHandle["child"] = { exitCode: null, signalCode: null,
      kill: () => { stopRequested = true; return true; } };
    const completion = (async () => {
      await input.prepare();
      if (released || stopRequested) {
        child.exitCode = 1;
        failReady(new Error("Plugin Runner startup cancelled"));
        return { code: 1, signal: null, stdout: "", stderr: "" };
      }
      if (operation.kind === "submit" && operation.launch) operation.launch.assets = input.assets?.() ?? [];
      environmentTaskOperationSchema.parse(operation);
      // Persist/mark dispatch before crossing the provider boundary. A lost reply
      // must reconcile this attempt and must never launch another task.
      await input.onDispatched?.();
      if (released || stopRequested) {
        child.exitCode = 1;
        failReady(new Error("Plugin Runner startup cancelled"));
        return { code: 1, signal: null, stdout: "", stderr: "" };
      }
      submitted = true;
      try { await call(operation); } catch {
        // Submission can have succeeded remotely. Inspect the same saved task.
        const state = await call({ kind: "status" });
        if (state.kind !== "status") throw new Error("Plugin Runner submission could not be reconciled");
      }
      let stopSent = false;
      for (;;) {
        if (detached) return await new Promise<never>(() => {});
        if (stopRequested && !stopSent) { await call({ kind: "stop" }); stopSent = true; }
        const state = await call({ kind: "status" });
        if (state.kind !== "status") throw new Error("Plugin Runner status unavailable");
        if (state.phase === "running" && !stopRequested) markReady();
        if (state.executionStopped === true) {
          child.exitCode = state.exitCode ?? (state.phase === "completed" ? 0 : 1);
          failReady(new Error("Plugin Runner stopped before connection"));
          return { code: child.exitCode, signal: null, stdout: "", stderr: "" };
        }
        await delay(pollMs);
      }
    })().catch(error => { failReady(error); throw new Error("Plugin Runner operation failed; reconcile the saved task"); });
    void completion.catch(() => undefined);
    return { child, completion };
  };
  const registration = async (authority: DurablePrpControlPlane, runId: string, signal?: AbortSignal) => {
    let outbound: ReturnType<typeof connectRunnerPrpIngress> | null = null;
    let activation: Promise<void> | null = null;
    const endpoint = async (): Promise<RunnerIngressEndpoint> => {
      const result = await call({ kind: "connection" });
      if (result.kind !== "connection") throw new Error("Plugin Runner connection unavailable");
      return { ...result.endpoint, refresh: endpoint, close: async () => {} };
    };
    return {
      connection: { mode: "listen" as const, listenAddress: "0.0.0.0" as const,
        listenPort: PAPERCLIP_RUNNER_INGRESS_PORT, listenPath: `${PAPERCLIP_RUNNER_CONNECT_PATH_PREFIX}/${encodeURIComponent(runId)}` },
      startupFailureCode: "runner_ingress_unavailable" as const,
      activate: () => {
        activation = (async () => {
          await running;
          if (released || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          const ingress = await endpoint();
          if (released || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          outbound = connectRunnerPrpIngress({ authority, endpoint: ingress });
          await outbound.ready;
        })();
        void activation.catch(() => undefined);
      },
      ready: async () => { await activation; },
      get failure() { return outbound?.failure; },
      checkpoint: async (settlement: "settled" | "unsettled") => {
        if (submitted) { stopRequested = true; await stopAndConfirm(); }
        await input.checkpoint(settlement);
        if (submitted) await call({ kind: "complete" });
      },
      release: async (reason?: "detach") => {
        released = true;
        if (reason === "detach") detached = true;
        // Native ownership release closes the PRP route before checkpointing.
        // Keep task grants until checkpoint succeeds; lease recovery owns failures.
        await outbound?.close();
      },
    };
  };
  return { launcher, registration };
}
