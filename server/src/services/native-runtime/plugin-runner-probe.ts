import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { copyBackGrokAuth } from "@paperclipai/adapter-grok-local/server";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { prepareGrokRunnerCredentials } from "./grok-runner-credentials.js";
import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import { environmentTaskResultSchema } from "@paperclipai/plugin-sdk";
import { probeNativeRunnerEnvironment } from "../../vendor/paperclip-runner/index.js";
import { createPluginRunnerTaskOwner, pluginRunnerEnvironment } from "./plugin-runner-task.js";
import { resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";
import { resolveAcpxQualification } from "./acpx-qualification.js";

/** Core verifies a real Runner; providers only implement their task API. */
export async function probePluginRunnerEnvironment(context: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  const target = context.executionTarget;
  if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runnerTask || !target.runnerTaskProbe || !target.leaseId) {
    throw new Error("Plugin Runner setup requires a Core-issued probe lease");
  }
  const task = target.runnerTask;
  const binding = target.runnerTaskProbe;
  const runnerId = `probe-${randomUUID()}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-runner-probe-")));
  let cleanupConfirmed = false;
  let probeStarted = false;
  try {
    const profile = resolvePaperclipRunnerProviderProfile(context.config);
    if (profile.provider !== "codex" && profile.provider !== "opencode" && profile.provider !== "acpx") throw new Error("Plugin Runner setup requires a workspace harness");
    const description = environmentTaskResultSchema.parse(await task({ kind: "describe", sessionId: binding.sessionId,
      harness: profile.provider === "acpx" ? profile.acpxAgent : profile.provider, projectIds: [], resources: ["runner_state", "provider_state", "runtime_context"] }));
    if (description.kind !== "description") throw new Error("Plugin Runner artifact description unavailable");
    if (profile.provider === "codex" && (!description.codexCommand || !description.codexArgs)) throw new Error("Plugin Runner Codex launch unavailable");
    const paths = description.resources;
    if (["runner_state", "provider_state", "runtime_context"].some(id => !paths[id])) throw new Error("Plugin Runner runtime description incomplete");
    const sourceEnvironment = Object.fromEntries(Object.entries(parseObject(context.config.env))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const sourceHome = sourceEnvironment.CODEX_HOME ?? "";
    const grok = profile.provider === "acpx" && profile.acpxAgent === "grok" ? await prepareGrokRunnerCredentials({
      companyId: context.companyId, environment: sourceEnvironment, remote: true, managedHome: sourceEnvironment.GROK_HOME,
    }) : null;
    const checkpoint = async (exports: { resource: string; targetPath: string }[] = []) => {
      const result = environmentTaskResultSchema.parse(await task({ kind: "checkpoint", exports }));
      if (result.kind !== "checkpoint") throw new Error("Plugin Runner probe state unavailable");
      return result.state;
    };
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [],
      harness: profile.provider === "acpx" ? profile.acpxAgent : profile.provider,
      connection: description.connection, prepare: async () => {},
      assets: () => [{ resource: "provider_state", sourcePath: join(root, profile.provider === "codex" ? "codex-home" : profile.provider) }]
        .filter(asset => existsSync(asset.sourcePath)),
      checkpoint: async () => {
        const state = await checkpoint([
          ...(profile.provider === "codex" && sourceHome ? [{ resource: "provider_state", targetPath: join(root, "refreshed-home") }] : []),
          ...(grok?.home ? [{ resource: "provider_auth", targetPath: join(root, "refreshed-grok") }] : []),
        ]);
        const expected = { schema: "paperclip.runner.durable.state.v1", runnerInstanceId: runnerId,
          environmentLeaseId: target.leaseId, runId: binding.runId, normalizedSessionId: binding.sessionId, lifecycle: "suspended" };
        if (Object.entries(expected).some(([key, value]) => state[key] !== value)) throw new Error("Plugin Runner probe checkpoint identity mismatch");

      },
    });
    probeStarted = true;
    const result = await probeNativeRunnerEnvironment({ runtimeDirectory: root, provider: profile.provider,
      model: profile.model, workingDirectory: target.remoteCwd, timeoutMs: 45_000,
      environment: pluginRunnerEnvironment(grok?.environment ?? sourceEnvironment, description.environment),
      transportOptions: {
        runnerArtifact: description.runner, runnerBinary: description.runner.executable,
        codexCommand: description.codexCommand, codexArgs: description.codexArgs, sourceCodexHome: sourceHome,
        runnerRuntimePaths: { environment: description.environment, codexHome: paths.provider_state, runtimeContext: paths.runtime_context, skillEntries: {} },
        runnerStateDirectory: paths.runner_state, readRunnerState: () => checkpoint(),
        runnerProcessLauncher: owner.launcher,
        ...(profile.provider === "opencode" ? { opencodePermissionMode: "deny", opencodeRuntimeDirectory: paths.provider_state } : {}),
        ...(profile.provider === "acpx" ? { acpxAgent: profile.acpxAgent, acpxPermissionMode: "deny-all", acpxPermissionModePinned: true,
          acpxCandidateProfile: profile.acpxAgent === "pi" ? undefined : resolveAcpxQualification({ kind: "acpx", agent: profile.acpxAgent, model: profile.model }, process.env),
          acpxRuntimeDirectory: paths.provider_state } : {}),
        ...(description.providerPack ? { providerPackAuthorityDigest: description.providerPack.authorityDigest,
          providerNodeCommand: description.providerPack.node.executable, providerNodeCommandSha256: description.providerPack.node.digest,
          acpxSidecarPath: description.providerPack.acpxSidecar?.executable, acpxSidecarSha256: description.providerPack.acpxSidecar?.digest,
          opencodeCommand: description.providerPack.opencodeExecutable?.executable, opencodeCommandSha256: description.providerPack.opencodeExecutable?.digest,
          opencodeProxyPath: description.providerPack.opencodeProxy?.executable, opencodeProxySha256: description.providerPack.opencodeProxy?.digest } : {}),
        prpIdentity: { runnerInstanceId: runnerId, environmentLeaseId: target.leaseId, runId: binding.runId,
          normalizedSessionId: binding.sessionId, turnId: `turn-${binding.runId}`, itemId: `item-${binding.runId}` },
        controlPlaneRegistration: (authority, identity, signal) => owner.registration(authority, identity?.runId ?? binding.runId, signal),
      },
      onCleanupConfirmed: async () => {
        if (profile.provider === "codex" && sourceHome) await copyBackCodexAuth({ hostAuthPath: join(sourceHome, "auth.json"),
          readSandboxAuth: async () => readFileSync(join(root, "refreshed-home/auth.json")), log: async () => {}, env: sourceEnvironment });
        if (grok?.home) await copyBackGrokAuth({ hostHomeDir: grok.home, log: () => {},
          readSandboxAuth: async () => {
            try { return Buffer.from(await readLocalAiCredentialFile(join(root, "refreshed-grok/auth.json"))); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              return Buffer.from(await readLocalAiCredentialFile(join(root, "refreshed-grok/auth-refresh.json"))); }
          } });
        cleanupConfirmed = true;
      },
    });
    return { adapterType: "paperclip_runner", status: "pass", testedAt,
      checks: [{ code: "runner_hello_probe_passed", level: "info", message: `Runner verified ${result.providerDriver} with model ${result.effectiveModel}.` }] };
  } catch {
    // Provider failures may contain credentials or private addressing.
    return { adapterType: "paperclip_runner", status: "fail", testedAt,
      checks: [{ code: "runner_hello_probe_failed", level: "error", message: "The selected plugin environment did not complete the Runner hello probe and confirmed cleanup. Check its runtime, account, and model access." }] };
  } finally {
    if (!probeStarted || cleanupConfirmed) rmSync(root, { recursive: true, force: true });
  }
}
