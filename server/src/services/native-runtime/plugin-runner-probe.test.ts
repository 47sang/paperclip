import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import WebSocket from "ws";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerProcessHandle } from "../../vendor/paperclip-runner/index.js";
const { spawnRunner } = await import(new URL("../../../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts", import.meta.url).href) as {
  spawnRunner: (options: any) => RunnerProcessHandle;
};
import { readRunnerdArtifactBinding } from "../../vendor/paperclip-runner/index.js";
import type { PluginEnvironmentTaskOperation, PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import { probePluginRunnerEnvironment } from "./plugin-runner-probe.js";

// Provider ingress TLS/reconnect is tested separately. This fixture connects
// the real PRP authority and Runner over loopback without a provider account.
vi.mock("../../realtime/runner-prp-outbound.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../realtime/runner-prp-outbound.js")>();
  return { ...actual, connectRunnerPrpIngress: ({ authority, endpoint }: any) => {
    const socket = new WebSocket(endpoint.websocketUrl.replace("wss:", "ws:"), { perMessageDeflate: false });
    const wire = new actual.WsJsonWireConnection(socket);
    const attachment = authority.attachWireConnection(wire);
    const ready = new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => { if (attachment.isAuthenticated()) { clearInterval(interval); resolve(); } }, 10);
      socket.once("error", error => { clearInterval(interval); reject(error); });
      socket.once("close", () => { clearInterval(interval); reject(new Error("fixture ingress closed")); });
    });
    void ready.catch(() => {});
    return { ready, failure: new Promise(() => {}), close: async () => { wire.close(); } };
  } };
});

describe("plugin Runner setup", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", "packages/paperclip-runner/runner/Cargo.toml",
      "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd", "--bin", "fake-codex-app-server"], { stdio: "pipe" });
  }, 600_000);
  it.each(["hello", "wrong-model", "invalid-checkpoint"])("requires the actual Runner/provider hello through the task API (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "plugin-probe-fixture-"));
    const workspace = join(root, "workspace");
    // Provider-selected locations share no prescribed runtime root or directory names.
    const resources: Record<string, string> = { runner_state: join(root, "records"), provider_state: join(root, "account"), runtime_context: join(root, "input.json") };
    await mkdir(workspace);
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const runnerBinary = resolve("packages/paperclip-runner/runner/target/release/paperclip-runnerd");
    const fakeCodex = resolve("packages/paperclip-runner/runner/target/release/fake-codex-app-server");
    const codexCommand = join(root, "fixture-codex");
    await writeFile(codexCommand, `#!/bin/sh\nexec '${fakeCodex.replace(/'/g, "'\\''")}' "$@" --state-file '${join(root, "fake-state.json")}' ${mode === "wrong-model" ? "--returned-model wrong-model" : ""}\n`);
    await chmod(codexCommand, 0o700);
    const artifact = readRunnerdArtifactBinding(runnerBinary);
    const probeRunId = randomUUID();
    const listenPath = `/api/runner/v1/connect/${probeRunId}`;
    const operations: PluginEnvironmentTaskOperation[] = [];
    let handle: ReturnType<typeof spawnRunner> | undefined;
    let stopped = false;
    const task = async (operation: unknown): Promise<PluginEnvironmentTaskResult> => {
      const op = operation as PluginEnvironmentTaskOperation;
      operations.push(op);
      switch (op.kind) {
        case "describe": return { kind: "description", taskId: "task", resources, environment: { HOME: resources.provider_state, CODEX_HOME: resources.provider_state },
          connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: port, listenPath },
          runner: { executable: runnerBinary, ...artifact }, codexCommand, codexArgs: ["app-server"] };
        case "submit": {
          const launch = op.launch!;
          for (const asset of launch.assets) await cp(asset.sourcePath, resources[asset.resource], { recursive: true });
          handle = spawnRunner({ ...launch, runnerBinaryPath: runnerBinary, stateDirectory: resources.runner_state,
            connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: port, listenPath }, ticket: op.bootstrapTicket,
            identity: { runnerInstanceId: op.runner.runnerId, environmentLeaseId: op.runner.leaseId, runId: op.runner.runId,
              normalizedSessionId: op.runner.sessionId, turnId: op.runner.turnId, itemId: op.runner.itemId },
            environment: launch.environment,
          });
          void handle.completion.then(() => { stopped = true; });
          const deadline = Date.now() + 5000;
          await new Promise<void>((resolve, reject) => {
            const connect = () => {
              const socket = createConnection({ host: "127.0.0.1", port });
              socket.once("connect", () => { socket.destroy(); resolve(); });
              socket.once("error", () => { socket.destroy();
                if (Date.now() >= deadline) reject(new Error("Fixture Runner did not listen"));
                else setTimeout(connect, 10);
              });
            };
            connect();
          });
          return { kind: "accepted", taskId: "task" };
        }
        case "connection": return { kind: "connection", taskId: "task", endpoint: {
          kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${port}${listenPath}`,
          generation: "fixture", secretHeaders: [],
        } };
        case "status": return { kind: "status", taskId: "task", phase: stopped ? "completed" : "running", executionStopped: stopped };
        case "stop": handle?.child.kill("SIGTERM"); return { kind: "accepted", taskId: "task" };
        case "checkpoint": {
          for (const asset of op.exports) await cp(resources[asset.resource], asset.targetPath, { recursive: true });
          return { kind: "checkpoint", taskId: "task", state: mode === "invalid-checkpoint" ? { runId: "wrong" } : JSON.parse(await readFile(join(resources.runner_state, "runner-state.json"), "utf8")) };
        }
        case "complete": return { kind: "accepted", taskId: "task" };
        default: throw new Error("Unexpected task operation");
      }
    };
    try {
      const result = await probePluginRunnerEnvironment({ companyId: "fixture", adapterType: "paperclip_runner",
        config: { provider: "codex", model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "synthetic-fixture" } },
        executionTarget: { kind: "remote", transport: "sandbox", providerKey: "plugin", leaseId: randomUUID(), remoteCwd: workspace,
          runnerTaskProbe: { runId: probeRunId, sessionId: randomUUID() }, runnerTask: task },
      });
      expect(result.status).toBe(mode === "hello" ? "pass" : "fail");
      expect(operations.some(op => op.kind === "submit")).toBe(true);
      if (mode !== "invalid-checkpoint") {
        expect(operations.some(op => op.kind === "stop")).toBe(true);
        expect(stopped).toBe(true);
      }
      expect(operations.some(op => op.kind === "complete")).toBe(mode !== "invalid-checkpoint");
    } finally { handle?.child.kill("SIGTERM"); await handle?.completion; await rm(root, { recursive: true, force: true }); }
  }, 65_000);
});
