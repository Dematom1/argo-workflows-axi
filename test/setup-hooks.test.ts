import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, run } from "./helpers.js";

describe("setup hooks failures", () => {
  it.each([
    ["read-only Codex hooks", { readonlyCodex: true }],
    ["read-only OpenCode config", { readonlyConfig: true }],
  ])("reports %s as a structured failure", (_name, options) => {
    const result = run(["setup", "hooks"], options);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: SETUP_FAILED");
    expect(result.stdout).toContain("Hook setup failed");
    expect(result.stdout).toContain(
      _name === "read-only Codex hooks" ? "codex" : "opencode",
    );
    expect(result.stdout).toContain("EACCES");
  });

  it("reports all failed writes with every affected agent and file", () => {
    const result = run(["setup", "hooks"], {
      readonlyClaude: true,
      readonlyCodex: true,
      readonlyConfig: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: SETUP_FAILED");
    for (const agent of ["claude", "codex", "opencode"]) {
      expect(result.stdout).toContain(agent);
    }
    expect(result.stdout).toContain(".codex/hooks.json");
    expect(result.stdout).toContain(".config/opencode/plugins");
    expect(result.stdout).toContain(".claude/settings.json");
  });

  it("persists an executable, shell-safe SessionEnd command", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "axi installed package "));
    mkdirSync(join(packageRoot, "dist", "bin"), { recursive: true });
    copyFileSync(
      BIN,
      join(packageRoot, "dist", "bin", "argo-workflows-axi.js"),
    );
    copyFileSync(
      BIN.replace("argo-workflows-axi.js", "argo-workflows-axi-ctx.js"),
      join(packageRoot, "dist", "bin", "argo-workflows-axi-ctx.js"),
    );
    chmodSync(join(packageRoot, "dist", "bin", "argo-workflows-axi.js"), 0o755);
    chmodSync(
      join(packageRoot, "dist", "bin", "argo-workflows-axi-ctx.js"),
      0o755,
    );
    symlinkSync(
      BIN.replace("/dist/bin/argo-workflows-axi.js", "/dist/src"),
      join(packageRoot, "dist", "src"),
    );
    symlinkSync(
      BIN.replace("/dist/bin/argo-workflows-axi.js", "/node_modules"),
      join(packageRoot, "node_modules"),
    );

    const result = run(["setup", "hooks"], {
      bin: join(packageRoot, "dist", "bin", "argo-workflows-axi.js"),
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(result.home, ".claude", "settings.json"), "utf8"),
    );
    const command = settings.hooks.SessionEnd[0].hooks[0].command;
    expect(command).toContain("axi installed package");
    expect(command).toContain("' context end # argo-workflows-axi");
    const invoked = spawnSync("/bin/sh", ["-c", command], {
      env: { ...process.env, HOME: result.home },
      encoding: "utf8",
    });
    expect(invoked.status).toBe(0);
  });
});
