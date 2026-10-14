# Plugin-provided Runner execution

Plugins provide Runner execution through environment drivers. The plugin prepares
the task's project and repository storage, starts Runner, and provides its Paperclip
Runner Protocol (PRP) connection. The plugin owns resource preparation and task
lifecycle. Declare `supportsTasks: true` on the driver and
implement `onEnvironmentTask`. The worker advertises `environmentTask` during
initialization. Both declarations must be present. The existing
`environment.drivers.register` capability applies.

The server-only `environmentRuntime.task({companyId, leaseId, operation})` method
loads the persisted lease and its run. It resolves the exact plugin recorded at
acquisition. It supplies the agent and issue context and validates requested
projects against the company. The persisted lease determines the plugin and
execution identity. An environment edit cannot redirect an existing task to a
replacement provider. The caller must
already authorize access to the company.

Submit includes `projectIds`, the projects whose storage the task needs. The host
checks that every ID belongs to the task's company and passes the validated list
to the plugin. The plugin resolves those projects into provider-specific storage
and mount inputs. The plugin prepares project and repository volumes before
starting Runner; PRP carries the subsequent Runner session.

## Core integration and required hooks

Assign a saved `plugin` environment to an agent using the `paperclip_runner`
adapter. Core requires `supportsTasks` in the manifest and `onEnvironmentTask`
in the live worker. It does not require `onEnvironmentExecute`, file-command
hooks, or `onEnvironmentRealizeWorkspace`. Missing task support fails closed.

Implement the lease hooks: `onEnvironmentAcquireLease`,
`onEnvironmentReleaseLease`, and `onEnvironmentDestroyLease`. Acquisition reserves
a unique task attempt and returns its workspace path in `metadata.remoteCwd`. Each attempt
needs its own provider lease ID, even when attempts share a persistent computer.
The plugin owns the authoritative project volumes and resolves the validated
project IDs into mounts before task startup. Core does not upload or restore a
host checkout over those volumes.

Core requests `describe` for the session, harness, and named resources. The plugin
returns qualified Runner/provider artifacts, listener settings, runtime environment,
and a `resources` map of provider-owned paths. Core forwards those protocol values
unchanged; it never joins, normalizes, or creates paths on the Runner host. There
is no required filesystem root, shell profile, PATH, home directory, or shared
filesystem with Core. Artifact identities must come from the installed plugin's
pinned image or trusted build manifest. Core authenticates the Runner over PRP.

The resource names express purpose, not directory layout:

- `runner_state`: durable Runner state in the Runner's checkpoint format.
- `provider_state`: isolated provider configuration and resumable state.
- `runtime_context`: the execution context document consumed by Runner.
- `instructions` and `instruction_working_copy`: assigned and editable agent files.
- `skill:<name>` and `skill_entry:<name>`: an assigned skill bundle and its entry file.
- `provider_auth`: refreshed subscription authentication, exported when requested.

Return every requested resource and keep its binding stable across attempts that resume the same session.
Return `codexCommand` and `codexArgs` for Codex, or a qualified `providerPack` for ACPX/OpenCode.
Executable resolution (including PATH lookup) belongs to the plugin; return resolved
paths where the installed Runner requires them for artifact verification. Project
file references remain relative to the bound workspace.
The provider configures its runtime environment, including any homes, search
paths, and packaged sidecar locations required by its installed Runner version.
Core retains authority over run identity, credential binding and permission policy.
Description environment settings must not contain credentials or authentication
overrides; credentials arrive only in the transient submit input. Core-selected
execution inputs take precedence over provider defaults.

On `submit`, Core supplies identity, a bootstrap ticket, expected artifact identity,
resource limits, lifecycle policy, selected environment/credentials, and named
`assets`. Each asset has a `resource` and a Core-local `sourcePath`; the plugin
materializes it at its own location before starting Runner. It can use HTTP,
storage, shell/exec, or another facility. Core does not select that transport.
Core does not send GitHub wrappers or prescribe a guest shell environment.
Assets are private: do not log them, reuse another attempt's credentials, or
replace project mounts while a task runs. Core-local paths are only readable by
the plugin worker on Core; they are never assumed to exist on the Runner host.

Core waits for `running`, obtains `connection`, and opens authenticated PRP.
PRP carries tools, provider sessions, results, and authorization. The task hook
also supplies bounded file handoff and durable checkpoints. Thus the plugin needs
no command endpoint and no Core fork. The integrated path supports per-turn
workspace sessions. Warm process retention and Dot's workspace-free backend are
not enabled for this driver. A replacement process needs a new task lease. Core authorizes a saved session's
lease transition only after the prior run is terminal and its execution has a
verified stop receipt. Company, agent, issue, workspace, environment, and pinned
plugin driver must match. PRP verifies and archives the prior suspended state
before binding the new lease. Interrupted archive steps are safe to retry.
Managed GitHub CLI shell bridges are not installed on task providers; semantic
Core tools retain their normal authorization.

## Files and durable state

`checkpoint` reads the task's durable Runner state and returns `state`. When
`exports` are present, export each named `resource` into its Core-owned `targetPath` before
returning. Replace exported directories atomically. Never follow symlinks out of
the bound resource, preserve private file modes, and fail when a requested
export cannot be completed. Core exports provider homes and Runner/provider state
after verified suspension. Core validates the returned identity and lifecycle.
It also exports the registered agent instruction working copy before task
completion revokes grants. The existing file store then validates and saves the
local mirror. A persisted task lease binding and checkpoint marker prevent a stale
mirror from being saved, including by the instruction recovery sweep. An export failure must not become a successful
save. Guest source locations are resolved by the plugin, never supplied by Core.

For authority rotation, `checkpoint.archive` supplies an archive key and the
prior identity. Atomically verify that the prior Runner is suspended, archive that
exact state, and return it. Repeating the same archive request returns the same
state. Never archive active or identity-conflicting state. Core independently
checks the returned state before rotating PRP authority. Preserve provider session
files and volumes across task lease cleanup so the next attempt can resume them.

`read_file` reads a relative path inside the task's bound project workspace.
Reject traversal, symlinks, non-regular files, and files that change during the
read. Check the requested size and digest before returning canonical base64.
Core also bounds and checks the returned bytes before accepting a deliverable.
There is no caller-selected filesystem root or arbitrary command.

## Lifetime and operations

Acquire the environment lease before submitting a task. The provider lease ID is
the task's durable attempt ID. Save it before a remote call. Do not use a persistent
machine ID as this task ID. Multiple attempts can use the same underlying resource. Provider task IDs are
opaque strings; each provider owns its addressing constraints.

- `describe`: returns the trusted artifact and session filesystem layout. Core
  validates its project IDs like submission. It does not start a process.
- `check_project_auth`: prepares the company-validated `projectIds` storage without starting Runner, then inspects OpenAI or Anthropic project authentication settings in the workspace and its parent directories. Return only a conflict boolean, never file contents or secrets. The SDK `checkRunnerProjectAuth` helper accepts a provider-owned file reader; return null only for missing files and reject other read failures. This operation must work before submission and must not require a shell hook.
- `checkpoint`: exports registered files and returns durable Runner state.
- `read_file`: returns a confined, size- and hash-checked workspace file.
- `submit`: supplies a unique list of up to 64 project UUIDs, Runner identity,
  harness, the client's supported PRP version range (`runner.protocolMin` and `runner.protocolMax`, inclusive), and a transient
  bootstrap ticket. The Runner run and lease IDs must match the persisted host records. Only a running run with an active,
  unexpired lease can submit. Core setup probes use a private, expiring probe identity on an ad-hoc lease instead of a heartbeat run.
- `status`: returns the phase and optional exit code. Optional `executionStopped`
  is live provider evidence that the complete task process tree has stopped.
- `connection`: returns a private authenticated WebSocket endpoint for a running
  task. The tenant connects to this provider endpoint. Transport credentials remain
  on the server. PRP authentication still binds
  the Runner to its authorized run.
- `complete`: releases task grants according to the provider's policy. It does not
  imply that the process or its descendants stopped.
- `stop`: requests cancellation of the task. An accepted request is not a process
  termination receipt. Reconcile status before treating execution as stopped.

Submit the task, wait until it is running, then request `connection` and connect
to its WSS endpoint with the returned headers. Core obtains this endpoint only from the plugin task response. The plugin owns provisioning, address discovery, TLS termination, authentication, and any HTTP or exec calls needed to deliver it. Core does not derive an endpoint from provider lease IDs or provider-specific URLs. The provider must select a Runner
whose supported PRP range overlaps the client's range. The client uses that same
range during the PRP handshake, which negotiates the highest shared version and
verifies Runner identity and artifacts before execution.

Submission, completion and stop return `accepted`. Acceptance does not imply
readiness or success. Status and connection return distinct typed results. Every
result echoes the task ID and is checked by both the worker SDK and the host.

## Retry and credentials

A timeout may follow successful submission. Retain the same task ID and launch
configuration, inspect status, and retry the exact request when needed. Never
allocate a second attempt merely because the response was lost. A stop issued before submission must fence that attempt against a late launch.
Providers must
reject conflicting reuse and deduplicate identical submissions, including after a
terminal outcome. A new execution attempt requires a new lease and task ID.

Do not store bootstrap tickets, connection headers, or provider credentials in
lease metadata, plugin state, run profiles, logs, or browser responses. The host
sanitizes worker errors. Treat a connection result as credential-bearing material.
An endpoint is transport access, not a replacement for the Runner protocol's
identity and artifact verification.

Providers own resource-specific credential lookup, mounts, task status, and cleanup.
Task lease cleanup must never destroy a longer-lived resource as an implicit
fallback. Unsupported operations and unavailable providers fail closed.

Cleanup operations (`status`, `complete`, `stop`) remain available when an
environment or run has been deleted. The corresponding `environmentId`, `runId`,
and `agentId` can be null. Providers must use their persisted lease binding for
cleanup; they must not need a current project or environment configuration.
Description, submission, connection, and workspace reads require the environment
and running run to still exist.
Cleanup receives an empty `projectIds` list and uses the persisted task binding.

## Cancellation and recovery

Core records a content-free dispatch marker on the lease before submitting. A lost
submit reply causes status reconciliation against the same task; Core does not
resubmit with a new identity. Cancellation while assets are still being prepared
prevents a late submission. Cancellation after dispatch calls `stop` and waits for
`executionStopped: true`; a terminal phase or an accepted stop is insufficient.

Core closes the PRP route, confirms task stop, verifies and installs the native
checkpoint, and only then sends `complete`. Failed exports keep task grants for
cleanup recovery. Core stores the original environment identity and the intended
lease cleanup hook. Recovery calls that pinned release or destroy hook even after
the environment record is deleted; a hook failure remains `pending_cleanup`.
Core checkpoints the existing native session state before completing task cleanup.
Lease release and destroy also check the dispatch marker, so a controller failure
does not bypass termination verification. Unconfirmed cleanup preserves the pinned
provider handle in `pending_cleanup`. The existing cleanup sweep retries stop,
status, and completion, including after the environment record is deleted. Only a
confirmed task stop produces a run-bound remote termination receipt.

The integrated fake-provider test acquires a real database lease and dispatches
through the SDK RPC host. It covers launch input forwarding, company/project denial,
connection, cancellation proof, lease release, and cleanup recovery after deletion.
The task fixture advertises no command or workspace hook. It also checks asset
handoff and instruction export failures. A separate Runner transport test uses
the real Runner binary to authenticate a provider-owned artifact.
The WebSocket connection is mocked in the database fixture; it is not live-provider or real
Runner handshake evidence. Providers must qualify their actual Runner and storage
implementation before production use.

## Agent setup verification

Normal agent initialization and the agent Test flow acquire a disposable task lease.
Core issues an expiring private Runner identity, with no issue, project mounts, or
agent tool authority. It uses the same describe, submit, connection, status,
checkpoint, stop, and complete operations as execution. No workspace-realization
or command hook is required. Core also bounds Runner's own lifetime through its supported maximum-runtime flag to the probe deadline, so a controller crash cannot leave an unlimited probe. Core runs a bounded read-only hello turn and checks
PRP identity, the qualified provider driver, the observed model, a completed
response, and confirmed task shutdown. A plugin readiness flag cannot replace
this probe. Managed accounts also require the project-auth check before launch.
Core preserves refreshed subscription credentials through checkpoint export.
