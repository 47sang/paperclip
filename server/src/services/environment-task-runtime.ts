import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { environmentTaskOperationSchema, parseEnvironmentTaskResult, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export async function pluginEnvironmentSupportsTasks(db: Db, workers: PluginWorkerManager, lease: { companyId: string; metadata: Record<string, unknown> | null }) {
  const metadata = lease.metadata ?? {};
  if (metadata.driver !== "plugin" || typeof metadata.pluginId !== "string" || typeof metadata.driverKey !== "string") return false;
  const plugin = await pluginRegistryService(db).getById(metadata.pluginId);
  const driver = plugin?.manifestJson.environmentDrivers?.find(value => value.driverKey === metadata.driverKey);
  const methods = workers.getWorker(metadata.pluginId)?.supportedMethods ?? [];
  return plugin?.status === "ready" && driver?.supportsTasks === true &&
    plugin.manifestJson.capabilities.includes("environment.drivers.register") &&
    methods.includes("environmentTask");
}

/** Server-only dispatch for plugin-provided Runner execution.
 * The caller supplies an authorized company and a persisted lease,
 * never a plugin identity, resource endpoint, or agent/project authority.
 * A timeout is ambiguous: retry the same operation against the same lease.
 */
export async function executeEnvironmentTask(db: Db, workers: PluginWorkerManager, input: {
  companyId: string;
  leaseId: string;
  operation: PluginEnvironmentTaskOperation;
}) {
  const operation = environmentTaskOperationSchema.parse(input.operation);
  const [row] = await db.select({ lease: environmentLeases, environment: environments, run: heartbeatRuns })
    .from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId))).limit(1);
  if (!row || !row.lease.providerLeaseId) throw new Error("Plugin-provided Runner execution lease unavailable");
  const { lease, environment, run } = row;
  const taskId = row.lease.providerLeaseId;
  if ((operation.kind === "describe" || operation.kind === "submit" || operation.kind === "connection" || operation.kind === "read_file") &&
      (!environment || !run || lease.status !== "active" || (lease.expiresAt && lease.expiresAt.getTime() <= Date.now()) ||
       run.status !== "running")) throw new Error("Plugin-provided Runner execution lease is not active");
  if (operation.kind === "submit" && (operation.runner.runId !== run?.id || operation.runner.leaseId !== lease.id)) {
    throw new Error("Plugin-provided Runner execution identity mismatch");
  }
  const metadata = lease.metadata ?? {};
  if (metadata.driver !== "plugin" || typeof metadata.pluginId !== "string" || typeof metadata.driverKey !== "string") {
    throw new Error("Plugin-provided Runner execution lease has no pinned plugin driver");
  }
  const plugin = await pluginRegistryService(db).getById(metadata.pluginId);
  const driver = plugin?.manifestJson.environmentDrivers?.find(value => value.driverKey === metadata.driverKey);
  if (!plugin || plugin.status !== "ready" || !driver?.supportsTasks ||
      !plugin.manifestJson.capabilities.includes("environment.drivers.register") ||
      !workers.getWorker(plugin.id)?.supportedMethods.includes("environmentTask")) {
    throw new Error("Plugin-provided Runner execution provider unavailable");
  }
  const issue = operation.kind === "submit" && lease.issueId ? await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId))).limit(1).then(rows => rows[0]) : null;
  if (operation.kind === "submit" && lease.issueId && !issue) throw new Error("Plugin-provided Runner execution issue unavailable");
  const projectIds = operation.kind === "submit" || operation.kind === "describe" ? operation.projectIds : [];
  if (projectIds.length > 0) {
    const authorizedProjects = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.companyId, input.companyId), inArray(projects.id, projectIds)));
    if (authorizedProjects.length !== projectIds.length) throw new Error("Plugin-provided Runner execution project unavailable");
  }
  // Provider identity comes from the lease. Editing the environment must never
  // redirect status or cleanup to a replacement plugin.
  const config = (environment?.config ?? {}) as Record<string, unknown>;
  const driverConfig = config.pluginKey === plugin.pluginKey && config.driverKey === metadata.driverKey
    ? (config.driverConfig as Record<string, unknown> | undefined) ?? {} : {};
  if (operation.kind === "submit") {
    // No ticket, headers, environment values, or launch paths belong in metadata.
    const marked = await db.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"runnerTaskDispatched":true,"runnerTaskExecutionStopped":false,"runnerTaskCheckpointed":false}'::jsonb`,
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.status, "active"))).returning({ id: environmentLeases.id });
    if (marked.length !== 1) throw new Error("Plugin-provided Runner execution lease is not active");
  }
  try {
    const result = await workers.call(plugin.id, "environmentTask", {
      driverKey: metadata.driverKey, companyId: input.companyId, environmentId: environment?.id ?? null,
      issueId: lease.issueId, config: driverConfig,
      taskId, runId: run?.id ?? null, agentId: run?.agentId ?? null, projectIds,
      lease: { providerLeaseId: lease.providerLeaseId, metadata: lease.metadata ?? undefined }, operation,
    }, 15_000);
    const parsed = parseEnvironmentTaskResult(operation, taskId, result);
    if (parsed.kind === "status" && parsed.executionStopped === true) {
      await db.update(environmentLeases).set({
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"runnerTaskExecutionStopped":true}'::jsonb`,
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId)));
    }
    if (operation.kind === "complete") {
      await db.update(environmentLeases).set({
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"runnerTaskDispatched":false}'::jsonb`,
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
        sql`${environmentLeases.metadata}->>'runnerTaskExecutionStopped' = 'true'`));
    }
    return parsed;
  } catch {
    // Worker errors and schema diagnostics can contain request credentials.
    throw new Error("Plugin-provided Runner execution operation unavailable; reconcile the same task before retrying");
  }
}

/** Failure leaves the dispatch marker and provider handle available to cleanup retries. */
export async function settleDispatchedEnvironmentTask(db: Db, workers: PluginWorkerManager, lease: { id: string; companyId: string }) {
  const [current] = await db.select({ metadata: environmentLeases.metadata }).from(environmentLeases)
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId))).limit(1);
  if (current?.metadata?.runnerTaskDispatched !== true) return current?.metadata?.runnerTaskExecutionStopped === true;
  const scope = { companyId: lease.companyId, leaseId: lease.id };
  try {
    await executeEnvironmentTask(db, workers, { ...scope, operation: { kind: "stop" } });
    const state = await executeEnvironmentTask(db, workers, { ...scope, operation: { kind: "status" } });
    if (state.kind !== "status" || state.executionStopped !== true) throw new Error("Plugin Runner termination is unconfirmed");
    await executeEnvironmentTask(db, workers, { ...scope, operation: { kind: "complete" } });
    return true;
  } catch {
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed",
      failureReason: "plugin_runner_task_cleanup_unconfirmed", releasedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
    throw new Error("Plugin Runner termination is unconfirmed; the saved lease requires cleanup");
  }
}
