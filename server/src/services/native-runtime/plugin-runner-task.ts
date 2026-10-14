import { setTimeout as delay } from "node:timers/promises";
import { environmentTaskOperationSchema, environmentTaskResultSchema, type PluginEnvironmentTaskOperation, type PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { RUNNER_PRP_PROTOCOL_MIN, RUNNER_PRP_PROTOCOL_MAX, type RunnerProcessHandle, type RunnerProcessLaunchSpec,
  type DurablePrpControlPlane, configuredEnvironment } from "../../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";

/** Do not project the controller's shell, homes or installed command locations into a task. */
export function pluginRunnerEnvironment(input: NodeJS.ProcessEnv, provided: Record<string, string>): NodeJS.ProcessEnv {
  const environment = { ...input };
  for (const key of Object.keys(environment)) {
    if (/^(PATH|HOME|USERPROFILE|CODEX_HOME|GROK_HOME|AGENT_HOME|HERMES_HOME|CLAUDE_CONFIG_DIR|OPENCODE_CONFIG(_DIR)?|AWS_SHARED_CREDENTIALS_FILE|AWS_CONFIG_FILE|AWS_WEB_IDENTITY_TOKEN_FILE|BASH_ENV|ZDOTDIR|SHELL|TMPDIR|GH_CONFIG_DIR|GIT_CONFIG_.*|GIT_SSH.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|PAPERCLIP_GITHUB_.*|PAPERCLIP_WORKSPACE_CWD)$/.test(key)) delete environment[key];
  }
  if (environment.PAPERCLIP_CONFIGURED_ENV_KEYS !== undefined) {
    environment.PAPERCLIP_CONFIGURED_ENV_KEYS = JSON.stringify(Object.keys(configuredEnvironment(input))
      .filter(key => key !== "PAPERCLIP_CONFIGURED_ENV_KEYS" && environment[key] !== undefined));
  }
  return { ...provided, ...environment };
}

/** Adapts a lease-bound task provider to the existing native process owner.
 * No provider pid is treated as a local pid. Only executionStopped settles it.
 */
export function createPluginRunnerTaskOwner(input: {
  task: (operation: unknown) => Promise<unknown>;
  projectIds: readonly string[];
  connection: Extract<NonNullable<RunnerProcessLaunchSpec["nativeRunner"]>["connection"], { mode: "listen" }>;
  harness: string;
  prepare: () => Promise<void>;
  assets?: () => { resource: string; sourcePath: string }[];
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
  let confirmStopped: (code: number) => void = () => {};
  let stoppedState: Extract<PluginEnvironmentTaskResult, { kind: "status" }> | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => undefined);
  const running = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  void running.catch(() => undefined);
  const call = async (operation: PluginEnvironmentTaskOperation) => {
    const result = environmentTaskResultSchema.parse(await input.task(operation));
    if (result.kind !== (operation.kind === "read_file" ? "file" : operation.kind === "describe" ? "description" : ["status", "connection", "checkpoint"].includes(operation.kind) ? operation.kind : "accepted")) {
      throw new Error("Plugin Runner returned an invalid operation result");
    }
    return result;
  };
  const readStatus = async (deadline = Date.now() + 15_000) => {
    for (;;) {
      if (stoppedState) return stoppedState;
      try {
        const state = await call({ kind: "status" });
        if (state.kind === "status") {
          if (state.executionStopped === true) {
            stoppedState = state;
            confirmStopped(state.exitCode ?? (state.phase === "completed" ? 0 : 1));
          }
          return state;
        }
      } catch { /* A failed read is not proof that execution stopped. */ }
      if (Date.now() >= deadline) throw new Error("Plugin Runner status unavailable; reconcile the saved task");
      await delay(pollMs);
    }
  };
  const stopAndConfirm = async () => {
    await call({ kind: "stop" });
    const deadline = Date.now() + 15_000;
    do {
      const state = await readStatus(deadline);
      if (state.executionStopped === true) return;
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
      launch: { runnerVersion: native.runnerVersion, runnerDigest: native.runnerDigest,
        maxOutboxBytes: native.maxOutboxBytes, p0ReserveBytes: native.p0ReserveBytes,
        maxRuntimeMs: native.maxRuntimeMs, maxLifetimeMs: native.maxLifetimeMs,
        reconnectGraceMs: native.reconnectGraceMs, lifecyclePolicy: native.lifecyclePolicy,
        environment: Object.fromEntries(Object.entries(spec.environment).filter(([key, value]) =>
          value !== undefined && key !== "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET")),
      },
    });
    launched = true;
    const child: RunnerProcessHandle["child"] = { exitCode: null, signalCode: null,
      kill: () => { stopRequested = true; return true; } };
    const completion = new Promise<Awaited<RunnerProcessHandle["completion"]>>(resolve => {
      confirmStopped = code => {
        if (child.exitCode !== null) return;
        child.exitCode = code;
        failReady(new Error("Plugin Runner stopped before connection"));
        resolve({ code, signal: null, stdout: "", stderr: "" });
      };
    });
    void (async () => {
      await input.prepare();
      if (released || stopRequested) {
        failReady(new Error("Plugin Runner startup cancelled"));
        confirmStopped(1);
        return;
      }
      if (operation.kind === "submit" && operation.launch) operation.launch.assets = input.assets?.() ?? [];
      environmentTaskOperationSchema.parse(operation);
      // Persist/mark dispatch before crossing the provider boundary. A lost reply
      // must reconcile this attempt and must never launch another task.
      await input.onDispatched?.();
      if (released || stopRequested) {
        failReady(new Error("Plugin Runner startup cancelled"));
        confirmStopped(1);
        return;
      }
      submitted = true;
      try { await call(operation); } catch {
        // Submission can have succeeded remotely. Inspect the same saved task.
        await readStatus();
      }
      let stopSent = false;
      while (child.exitCode === null) {
        if (detached) return;
        if (stopRequested && !stopSent) { await call({ kind: "stop" }); stopSent = true; }
        const state = await readStatus();
        if (state.phase === "running" && !stopRequested) markReady();
        if (state.executionStopped === true) return;
        await delay(pollMs);
      }
    })().catch(error => {
      if (stoppedState) return;
      failReady(error);
      rejectFailure(new Error("Plugin Runner operation failed; reconcile the saved task"));
      if (!submitted) confirmStopped(1);
    });
    return { child, completion, restart: null };
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
      connection: input.connection,
      startupFailureCode: "runner_ingress_unavailable" as const,
      activate: () => {
        activation = (async () => {
          await running;
          if (released || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          const ingress = await endpoint();
          if (released || signal?.aborted) throw new Error("Plugin Runner startup cancelled");
          outbound = connectRunnerPrpIngress({ authority, endpoint: ingress });
          void outbound.failure?.catch(rejectFailure);
          await outbound.ready;
        })();
        void activation.catch(() => undefined);
      },
      ready: async () => { await activation; },
      failure,
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
