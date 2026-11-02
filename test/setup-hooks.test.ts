import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

describe("setup hooks failures", () => {
  it.each([
    ["read-only Codex hooks", { readonlyCodex: true }],
    ["read-only OpenCode config", { readonlyConfig: true }],
  ])("reports %s as a structured failure", (_name, options) => {
    const result = run(["setup", "hooks"], options);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: SETUP_FAILED");
    expect(result.stdout).toContain("Hook setup failed");
    expect(result.stdout).toContain("EACCES");
  });
});
