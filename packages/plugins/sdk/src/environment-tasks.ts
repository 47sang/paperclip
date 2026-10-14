import { z } from "zod";
import type { PluginEnvironmentDriverBaseParams, PluginEnvironmentLease } from "./protocol.js";

// Provider IDs are opaque; providers validate their own addressing constraints.
const providerId = z.string().min(1);
// These are provider-issued protocol values, never resolved against Core's filesystem.
const runtimePath = z.string().min(1).max(4096).regex(/^[^\x00-\x1f]+$/);
const resourceId = z.string().min(1).max(200);
// Descriptions are runtime configuration; selected credentials arrive only on submit.
const runtimeEnvironment = z.record(z.string().refine(key => !/(?:^|_)(?:KEYS?|TOKEN|SECRET|CREDENTIALS?|AUTH)(?:_|$)|^PAPERCLIP_.*PROVIDERS$|^OPENCODE_CONFIG_CONTENT$/i.test(key),
  "Provider runtime settings cannot contain credentials or authentication overrides"), z.string());
const asset = z.object({ resource: resourceId, sourcePath: runtimePath }).strict();
const exportedAsset = z.object({ resource: resourceId, targetPath: runtimePath }).strict();
const runnerArtifact = z.object({ executable: runtimePath, version: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
// PRP identity.schema.json stableId.
const runnerIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const secureUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
}, "Expected a credential-free WSS URL");

/** One plugin-provided Runner execution attempt with a PRP connection. Secrets are transient RPC input. */
export const environmentTaskOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("describe"), sessionId: runnerIdentity, harness: identifier,
    projectIds: z.array(z.string().uuid()).max(64), resources: z.array(resourceId).max(256).default([]) }).strict(),
  z.object({ kind: z.literal("checkpoint"),
    exports: z.array(exportedAsset).max(128).default([]),
    archive: z.object({ archiveKey: runnerIdentity, priorIdentity: z.object({
      runnerInstanceId: runnerIdentity, environmentLeaseId: runnerIdentity, runId: runnerIdentity,
      normalizedSessionId: runnerIdentity, turnId: runnerIdentity, itemId: runnerIdentity,
    }).strict() }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("submit"),
    projectIds: z.array(z.string().uuid()).max(64).refine(ids => new Set(ids).size === ids.length, "Duplicate project IDs"),
    runner: z.object({
      /** Inclusive PRP version range supported by the submitting client. */
      protocolMin: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      protocolMax: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      harness: identifier,
      runnerId: runnerIdentity, leaseId: runnerIdentity, runId: runnerIdentity,
      sessionId: runnerIdentity, turnId: runnerIdentity, itemId: runnerIdentity,
    }).strict().refine(value => value.protocolMin <= value.protocolMax, "Invalid PRP version range"),
    bootstrapTicket: z.string().min(1).max(65_536),
    /** Core supplies these protected launch inputs for native agent runs. */
    launch: z.object({
      /** Named Core-owned inputs; the plugin decides where and how to materialize them. */
      assets: z.array(asset).max(128).default([]),
      runnerVersion: z.string().min(1), runnerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      maxOutboxBytes: z.number().int().positive(), p0ReserveBytes: z.number().int().positive(),
      maxRuntimeMs: z.number().int().nonnegative().optional(), maxLifetimeMs: z.number().int().nonnegative().optional(),
      reconnectGraceMs: z.number().int().nonnegative().optional(),
      lifecyclePolicy: z.object({ mode: z.literal("per_turn"), idleTimeoutMs: z.null() }).strict(),
      environment: z.record(z.string(), z.string()),
    }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal("read_file"), contentRef: z.string().min(1).max(2000)
    .refine(value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..") && value !== "." && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !/[\x00-\x1f]/.test(value)),
    byteSize: z.number().int().positive().max(64 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({ kind: z.literal("check_project_auth"),
    provider: z.enum(["openai", "anthropic"]), projectIds: z.array(z.string().uuid()).max(64),
  }).strict(),
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("connection") }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);

export const environmentTaskResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), taskId: providerId }).strict(),
  z.object({ kind: z.literal("description"), taskId: providerId,
    runner: runnerArtifact, codexCommand: runtimePath.optional(), codexArgs: z.array(z.string().max(4096).regex(/^[^\x00]*$/)).max(64).optional(),
    resources: z.record(resourceId, runtimePath),
    environment: runtimeEnvironment.default({}),
    connection: z.object({ mode: z.literal("listen"), listenAddress: z.literal("0.0.0.0"),
      listenPort: z.number().int().min(1).max(65_535), listenPath: z.string().startsWith("/") }).strict(),
    providerPack: z.object({ authorityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      node: runnerArtifact, acpxSidecar: runnerArtifact.optional(),
      opencodeExecutable: runnerArtifact.optional(), opencodeProxy: runnerArtifact.optional(),
    }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal("project_auth"), taskId: providerId, conflict: z.boolean() }).strict(),
  z.object({ kind: z.literal("file"), taskId: providerId, base64: z.string().max(90 * 1024 * 1024) }).strict(),
  z.object({ kind: z.literal("checkpoint"), taskId: providerId,
    /** Independently checked by Core against its PRP authority and suspension state. */
    state: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    kind: z.literal("status"), taskId: providerId,
    phase: z.enum(["preparing", "running", "completed", "failed", "cancelled", "interrupted"]),
    exitCode: z.number().int().optional(),
    /** Provider observed the task and all descendants stopped; terminal phase alone is insufficient. */
    executionStopped: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("connection"), taskId: providerId,
    endpoint: z.object({
      kind: z.literal("authenticated_websocket"), websocketUrl: secureUrl,
      generation: providerId,
      secretHeaders: z.array(z.object({
        name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        value: z.string().min(1).max(65_536).regex(/^[^\r\n]+$/),
      }).strict()).max(16),
    }).strict(),
  }).strict(),
]);

export type PluginEnvironmentTaskOperation = z.infer<typeof environmentTaskOperationSchema>;
export type PluginEnvironmentTaskResult = z.infer<typeof environmentTaskResultSchema>;

export interface PluginEnvironmentTaskParams extends Omit<PluginEnvironmentDriverBaseParams, "environmentId"> {
  /** Null during cleanup after the environment is deleted. */
  environmentId: string | null;
  lease: PluginEnvironmentLease;
  /** Provider-issued task identifier persisted in the lease, stable across ambiguous submission retries. */
  taskId: string;
  /** Null during cleanup after the associated run is deleted. */
  runId: string | null;
  agentId: string | null;
  /** Company-validated projects to prepare on submit; empty during cleanup. */
  projectIds: string[];
  operation: PluginEnvironmentTaskOperation;
}

/** An accepted stop is not proof of process termination. */
export function parseEnvironmentTaskResult(operation: PluginEnvironmentTaskOperation, taskId: string, value: unknown): PluginEnvironmentTaskResult {
  const result = environmentTaskResultSchema.parse(value);
  const expected = operation.kind === "check_project_auth" ? "project_auth" : operation.kind === "read_file" ? "file" : operation.kind === "describe" ? "description" : ["status", "connection", "checkpoint"].includes(operation.kind) ? operation.kind : "accepted";
  if (result.taskId !== taskId || result.kind !== expected) throw new Error("Invalid plugin-provided Runner execution response");
  if (operation.kind === "describe" && result.kind === "description" &&
      operation.resources.some(resource => !result.resources[resource])) throw new Error("Plugin omitted a requested runtime resource");
  return result;
}

/** File access stays provider-owned. Missing files return null; all other read failures must reject. */
export async function checkRunnerProjectAuth(
  operation: { provider: "openai" | "anthropic"; cwd: string },
  readFile: (absolutePath: string) => Promise<string | null>,
): Promise<boolean> {
  const files = operation.provider === "anthropic" ? [".claude/settings.json", ".claude/settings.local.json"] : [".codex/config.toml"];
  let directory = operation.cwd.replace(/\/+$/, "") || "/";
  for (;;) {
    for (const relative of files) {
      const content = await readFile(`${directory === "/" ? "" : directory}/${relative}`);
      if (content !== null) {
        if (new TextEncoder().encode(content).length > 1024 * 1024) throw new Error("Project authentication file exceeds the inspection limit");
        if (/apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider\s*=|env_key\s*=|experimental_bearer_token|cli_auth_credentials_store/.test(content)) return true;
      }
    }
    if (directory === "/") return false;
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
}
