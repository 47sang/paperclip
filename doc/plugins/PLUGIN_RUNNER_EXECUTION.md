# Plugin-provided Runner execution

## Contract sources and ownership

The SDK defines the RPC contract:

- [Task operations, results, and validators](../../packages/plugins/sdk/src/environment-tasks.ts)
- [Lease and driver types](../../packages/plugins/sdk/src/protocol.ts)

Type references in this document use the SDK exports:

```ts
import type {
  PluginEnvironmentTaskOperation as Operation,
  PluginEnvironmentTaskResult as Result,
  PluginEnvironmentTaskParams as Params,
} from "@paperclipai/plugin-sdk";

type Request<K extends Operation["kind"]> = Extract<Operation, { kind: K }>;
type Response<K extends Result["kind"]> = Extract<Result, { kind: K }>;
type TaskHook = (params: Params) => Promise<Result>;
```

| Term | Definition | Owner |
| --- | --- | --- |
| Core | Paperclip server | Company authorization, execution identity, credentials, permission policy |
| Plugin | Installed environment driver and worker | Storage, task process, runtime layout, transport, cleanup |
| Runner | Qualified Paperclip Runner process | Provider execution and Paperclip Runner Protocol (PRP) |
| Task | One execution attempt | Plugin; identified by `providerLeaseId` |
| Resource | Named input, output, or durable state | Core selects the name; plugin selects the Runner path |
| Checkpoint | Durable Runner state and requested resource exports | Plugin supplies; Core verifies |

## Enable the driver

1. Add the capability and driver declaration to the plugin manifest.

```json
{
  "capabilities": ["environment.drivers.register"],
  "environmentDrivers": [{ "driverKey": "runner", "supportsTasks": true }]
}
```

This example is a manifest fragment. Other required manifest fields are omitted.

2. Write code for these worker hooks.

```ts
// Required hooks; the worker SDK advertises environmentTask at initialization.
onEnvironmentAcquireLease
onEnvironmentTask // TaskHook
onEnvironmentReleaseLease
onEnvironmentDestroyLease

// Not required by task execution:
onEnvironmentExecute
onEnvironmentRealizeWorkspace
```

3. Assign a saved `plugin` environment to an agent with adapter type `paperclip_runner`.

| Execution profile | Support |
| --- | --- |
| Per-turn workspace session | Supported |
| Normal agent initialization and Test | Runner setup probe |
| Codex | `codexCommand` and `codexArgs` |
| Qualified ACPX/OpenCode | `providerPack` |
| Warm process retention; Dot workspace-free backend | Not enabled |
| Managed GitHub CLI shell bridge | Not installed; semantic Core tools keep normal authorization |

## Acquire a task lease

Example `onEnvironmentAcquireLease` result:

```json
{
  "providerLeaseId": "attempt-1",
  "metadata": { "remoteCwd": "/provider-selected/project" }
}
```

1. Set a unique task ID for each attempt.
2. Save the task ID before a remote call.
3. Return the workspace path in `metadata.remoteCwd`.
4. Keep persistent machine IDs separate from task IDs.

The path above is a plugin-selected example. Core does not create or inspect that directory.

```ts
// Core's server-only entry point; the caller authorizes company access.
environmentRuntime.task({ companyId, leaseId, operation });

// The plugin receives Params, including:
type Context = Pick<Params,
  | "driverKey" | "companyId" | "environmentId" | "issueId" | "config"
  | "lease" | "taskId" | "runId" | "agentId" | "projectIds" | "operation"
>;
```

| Binding | Source or constraint |
| --- | --- |
| `taskId` | Persisted `lease.providerLeaseId`; opaque, nonempty string |
| Plugin and driver | Pinned acquisition record; environment edits cannot redirect an existing lease |
| Company, agent, issue, run | Core records |
| `projectIds` | Core-validated company projects; maximum 64 UUIDs |
| Cleanup context | `environmentId`, `runId`, `agentId` can be `null`; `projectIds: []` |
| Active operations | `describe`, `check_project_auth`, `submit`, `connection`, `read_file`: active, unexpired lease and authorized execution |
| Execution authority | Running heartbeat run, or private expiring setup-probe identity |
| Deleted environment or run | `status`, `stop`, `complete` remain available through the pinned lease |

Use the saved lease binding for cleanup. Do not require current project or environment records for cleanup.

## Operations and results

| `operation.kind` | Required result `kind` | Effect |
| --- | --- | --- |
| `describe` | `description` | Runtime configuration; no process start |
| `check_project_auth` | `project_auth` | Project authentication inspection; no Runner start |
| `submit` | `accepted` | Launch request |
| `status` | `status` | Observed task state |
| `connection` | `connection` | Authenticated WSS endpoint |
| `checkpoint` | `checkpoint` | Durable state and requested exports |
| `read_file` | `file` | Bounded workspace file |
| `stop` | `accepted` | Cancellation request |
| `complete` | `accepted` | Task grant release |

Return the request's `taskId` in every result. Reject unsupported operations.

```ts
import { parseEnvironmentTaskResult } from "@paperclipai/plugin-sdk";

// Worker SDK and Core both validate the response.
parseEnvironmentTaskResult(operation, taskId, result);

// Acceptance is not readiness, successful execution, or proof of termination.
type Accepted = Response<"accepted">; // { kind: "accepted"; taskId: string }
type Phase = Response<"status">["phase"];
// "preparing" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
```

## Describe runtime resources

Example operation:

```json
{
  "kind": "describe",
  "sessionId": "session-1",
  "harness": "codex",
  "projectIds": [],
  "resources": ["runner_state", "provider_state", "runtime_context"]
}
```

Example result, with illustrative paths and artifact identity:

```json
{
  "kind": "description",
  "taskId": "attempt-1",
  "runner": {
    "executable": "/provider-selected/bin/paperclip-runner",
    "version": "1.0.0",
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "codexCommand": "codex",
  "codexArgs": ["app-server"],
  "resources": {
    "runner_state": "/provider-selected/session/runner",
    "provider_state": "/provider-selected/session/account",
    "runtime_context": "/provider-selected/session/context.json"
  },
  "environment": { "CODEX_HOME": "/provider-selected/session/account" },
  "connection": {
    "mode": "listen",
    "listenAddress": "0.0.0.0",
    "listenPort": 9000,
    "listenPath": "/api/runner/v1/connect/run-1"
  }
}
```

| Resource name | Content |
| --- | --- |
| `runner_state` | Durable state in Runner checkpoint format |
| `provider_state` | Isolated provider configuration and resumable state |
| `runtime_context` | Runner execution context document |
| `instructions` | Assigned agent files |
| `instruction_working_copy` | Editable agent files |
| `skill:<name>` | Assigned skill bundle |
| `skill_entry:<name>` | Skill entry file |
| `provider_auth` | Refreshed subscription credentials, when requested |

1. Return every requested resource.
2. Keep resource bindings unchanged across attempts that resume the same session.
3. Use artifact identities from the plugin's pinned image or trusted build manifest.
4. Replace the example artifact identity with the installed artifact's identity.
5. Use executable paths that meet the installed Runner's artifact verification requirements.
6. Set listener parameters for the installed Runner and the request's run ID.
7. Keep credentials and authentication overrides out of `description.environment`.

```ts
// Codex profile:
type Codex = Required<Pick<Response<"description">, "codexCommand" | "codexArgs">>;

// ACPX/OpenCode profile; artifact fields: executable, version, digest.
type ProviderPack = NonNullable<Response<"description">["providerPack"]>;
// authorityDigest, node, optional acpxSidecar, opencodeExecutable, opencodeProxy
```

| Value | Contract |
| --- | --- |
| Runner paths | Plugin-issued protocol values; Core forwards them unchanged |
| Executable names on `PATH` | Allowed where supported by the installed Runner |
| Project file references | Relative to the bound workspace |
| Homes, search paths, sidecars | Plugin configuration; no Core-selected layout |
| `description.connection` | Runner listener configuration; not the external WSS endpoint |
| `description.environment` | Non-secret defaults; Core-selected execution inputs take precedence |
| `describe.resources` | Maximum 256 bindings; two paths per skill fit within the 128-asset limit |
| Path strings | 1–4096 characters; no ASCII control characters U+0000–U+001F |

## Submit the task

Example operation, with illustrative identities and a ticket placeholder:

```json
{
  "kind": "submit",
  "projectIds": [],
  "runner": {
    "protocolMin": 1, "protocolMax": 1, "harness": "codex",
    "runnerId": "runner-1", "leaseId": "core-lease-1", "runId": "run-1",
    "sessionId": "session-1", "turnId": "turn-1", "itemId": "item-1"
  },
  "bootstrapTicket": "example-only",
  "launch": {
    "assets": [{ "resource": "runtime_context", "sourcePath": "/core-selected/input/context.json" }],
    "runnerVersion": "1.0.0",
    "runnerDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "maxOutboxBytes": 1048576, "p0ReserveBytes": 65536,
    "lifecyclePolicy": { "mode": "per_turn", "idleTimeoutMs": null },
    "environment": {}
  }
}
```

| Field | Constraint |
| --- | --- |
| `projectIds` | Unique UUIDs; maximum 64 |
| `runner.leaseId`, `runner.runId` | Core lease and execution IDs; distinct from plugin `taskId` |
| `runner.protocolMin`, `runner.protocolMax` | Inclusive client-supported range; minimum ≤ maximum |
| `bootstrapTicket` | Core-issued transient secret; no plugin substitution |
| `launch` | Optional in the SDK; supplied by Core for native execution |
| `launch.assets` | Maximum 128 named inputs |
| `launch.environment` | Core-selected inputs, including credentials |
| `launch.maxRuntimeMs`, `maxLifetimeMs`, `reconnectGraceMs` | Optional nonnegative integers |

1. Prepare storage for the validated `projectIds` before Runner starts.
2. Copy each asset from its Core-local `sourcePath` to its bound resource location.
3. Select a Runner with a PRP version range that overlaps `[protocolMin, protocolMax]`.
4. Start Runner with the supplied identity, ticket, limits, and lifecycle policy.
5. Keep project mounts unchanged while the task runs.

| Asset boundary | Rule |
| --- | --- |
| `sourcePath` | Readable by the plugin worker on Core; not a Runner-host path |
| Transfer method | Plugin choice: HTTP, object storage, shell/exec, or another facility |
| Project volumes | Plugin authority; no Core checkout upload or restore over project storage |
| Private input | No asset logging or credential reuse across attempts |
| Core authority | Run identity, selected credentials, permission policy |

## Return the WSS endpoint

Example `connection` result:

```json
{
  "kind": "connection",
  "taskId": "attempt-1",
  "endpoint": {
    "kind": "authenticated_websocket",
    "websocketUrl": "wss://runner.example.com/tasks/attempt-1",
    "generation": "generation-1",
    "secretHeaders": [{ "name": "Authorization", "value": "example-only" }]
  }
}
```

| Endpoint field | Constraint |
| --- | --- |
| `websocketUrl` | `wss:`; no URL credentials, query, or fragment |
| `generation` | Nonempty opaque string |
| `secretHeaders` | Maximum 16; valid HTTP header names; no CR/LF in values |
| Provisioning and discovery | Plugin-owned; no required HTTP, exec, or shell API |
| TLS termination and transport authentication | Plugin-owned |
| Core connection | Exact returned endpoint and headers; no address derivation from lease IDs |
| PRP handshake | Highest shared version; independent identity and artifact verification |

Do not store tickets, headers, or credentials in lease metadata, plugin state, run profiles, logs, or browser responses.

## Lifecycle, retry, and cancellation

Core's execution sequence, shown as pseudocode:

```text
acquire lease -> describe -> prepare assets -> persist dispatch marker -> submit
status until running -> connection -> authenticated PRP session
close PRP route -> stop -> status until executionStopped == true
checkpoint -> verify and install exported state -> complete -> release/destroy lease
```

| Event | Required plugin behavior |
| --- | --- |
| Lost submit response | Same task ID and launch configuration remain valid for reconciliation |
| Repeated identical submit | One execution, including retries after a terminal outcome |
| Conflicting reuse of task ID | Rejection |
| Stop before submit | Attempt fenced against a late launch |
| New execution attempt | New lease and task ID |
| Accepted stop or terminal phase | Insufficient termination evidence |
| `executionStopped: true` | Observed termination of the task and all descendants |
| `complete` | Grant release; not process termination evidence |
| Lease cleanup | Persistent session files and longer-lived volumes retained |

Core prevents submission after cancellation during asset preparation. After dispatch, Core requires verified termination before lease cleanup.
Unconfirmed termination or failed cleanup remains `pending_cleanup`. Recovery uses the pinned provider and original release/destroy hook.
Failed exports retain task grants for recovery. Only confirmed termination produces a run-bound remote termination receipt.

## Checkpoint and file transfer

Example checkpoint operation:

```json
{
  "kind": "checkpoint",
  "exports": [{ "resource": "instruction_working_copy", "targetPath": "/core-selected/export/instructions" }]
}
```

```ts
type Checkpoint = Request<"checkpoint">;
type CheckpointResult = Response<"checkpoint">; // { kind, taskId, state }
type Archive = NonNullable<Checkpoint["archive"]>;
// archiveKey; priorIdentity: { runnerInstanceId, environmentLeaseId, runId,
//                            normalizedSessionId, turnId, itemId }
```

1. Before you return the result, export each requested resource to its Core-owned `targetPath`.
2. Replace exported directories atomically.
3. Keep private file modes unchanged.
4. Reject symlinks that leave the bound resource.
5. If an export fails, reject the operation.
6. Return durable Runner state in `state`.

| Checkpoint use | Additional requirements |
| --- | --- |
| Normal suspension | Core validates state identity and lifecycle before installation |
| Instruction save | Export before `complete`; persisted lease binding and checkpoint marker prevent stale saves |
| Recovery sweep | Same validation as normal instruction save; export failure cannot become a successful save |
| `archive` | Atomic verification and archive of the exact suspended prior identity |
| Repeated archive key and identity | Same archived state; interrupted archive safe to retry |
| Active or conflicting prior state | Rejection |
| Session lease transition | Prior run terminal and verified stop; matching company, agent, issue, workspace, environment, and pinned driver |

Example workspace file operation and result:

```json
{
  "kind": "read_file",
  "contentRef": "output/report.txt",
  "byteSize": 6,
  "sha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
}
```

```json
{ "kind": "file", "taskId": "attempt-1", "base64": "aGVsbG8K" }
```

1. Read `contentRef` relative to the task's bound project workspace.
2. Reject traversal, symlinks, non-regular files, and files that change during the read.
3. Before you return canonical base64, make sure the size and SHA-256 digest match the request.

The maximum file size is 64 MiB. Core independently validates the returned bytes.

## Project authentication and setup verification

Example operation and result:

```json
{ "kind": "check_project_auth", "provider": "openai", "projectIds": [] }
```

```json
{ "kind": "project_auth", "taskId": "attempt-1", "conflict": false }
```

1. Prepare the validated project storage before inspecting authentication settings.
2. Examine provider configuration in the workspace and its parent directories.
3. Return only the conflict boolean.
4. Do not return configuration contents or secrets.
5. Make sure this operation can run before `submit` without a shell hook.

Optional SDK helper for POSIX-style paths:

```ts
import { checkRunnerProjectAuth } from "@paperclipai/plugin-sdk";

checkRunnerProjectAuth(
  { provider: "openai", cwd: pluginSelectedWorkspace },
  providerReadFile, // (absolutePath: string) => Promise<string | null>
);
// Missing file -> null; other read failures -> rejection.
// "openai": .codex/config.toml
// "anthropic": .claude/settings.json, .claude/settings.local.json
```

| Setup probe | Core behavior |
| --- | --- |
| Trigger | Normal agent initialization and agent Test |
| Authority | Disposable lease; private expiring identity; no issue, project mounts, or agent tool authority |
| Operations | Same task operations as execution |
| Execution | Bounded read-only hello turn; Runner maximum runtime tied to probe deadline |
| Acceptance | Verified PRP identity, qualified provider driver, expected model, completed response, confirmed shutdown |
| Managed account | Project-auth inspection before launch; refreshed credentials preserved by checkpoint export |
| Plugin readiness flag | Insufficient evidence; cannot replace the Runner probe |

## Verification scope

| Test | Evidence |
| --- | --- |
| [Task integration](../../server/src/__tests__/plugin-runner-task.integration.test.ts) | Database lease, SDK RPC, company/project denial, assets, instruction export, cancellation, cleanup after deletion |
| [Setup probe](../../server/src/services/native-runtime/plugin-runner-probe.test.ts) | Real Runner, provider-selected paths, task-only worker, authenticated setup turn and shutdown |
| [Runner transport](../../packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts) | Real Runner artifact authentication and runtime binding |

The database fixture mocks the WebSocket connection. These tests do not qualify a live provider's storage or transport.

Before production use, do qualification tests for the plugin's actual Runner, storage, and transport.
