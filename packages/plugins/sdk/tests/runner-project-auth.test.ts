import { describe, expect, it, vi } from "vitest";
import { checkRunnerProjectAuth } from "../src/environment-tasks.js";

describe("provider-owned project authentication inspection", () => {
  it.each(["openai", "anthropic"] as const)("inspects ancestors through a file API (%s)", async provider => {
    const reader = vi.fn(async (path: string) => path === (provider === "openai" ? "/workspace/.codex/config.toml" : "/workspace/.claude/settings.local.json")
      ? provider === "openai" ? 'model_provider = "custom"' : '{"apiKeyHelper":"custom"}' : null);
    expect(await checkRunnerProjectAuth({ kind: "check_project_auth", cwd: "/workspace/project", provider }, reader)).toBe(true);
    expect(reader).toHaveBeenCalledWith(provider === "openai" ? "/workspace/project/.codex/config.toml" : "/workspace/project/.claude/settings.json");
  });
  it("fails closed on read errors and oversize files", async () => {
    const operation = { kind: "check_project_auth", cwd: "/workspace", provider: "openai" } as const;
    await expect(checkRunnerProjectAuth(operation, async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
    await expect(checkRunnerProjectAuth(operation, async () => "x".repeat(1024 * 1024 + 1))).rejects.toThrow("inspection limit");
    expect(await checkRunnerProjectAuth(operation, async () => null)).toBe(false);
    expect(await checkRunnerProjectAuth(operation, async () => 'model = "gpt-test"')).toBe(false);
  });
});
