import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, outcome, run } from "./helpers.js";

describe("setup hooks failures", () => {
  it("repairs SessionStart without dereferencing malformed groups or commands", () => {
    const malformed = [
      null,
      "legacy",
      { hooks: [null, { command: 42, marker: "argo-workflows-axi" }] },
    ];
    const result = run(["setup", "hooks"], {
      claudeSettings: JSON.stringify({ hooks: { SessionStart: malformed } }),
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(result.home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart).toContain(null);
    expect(settings.hooks.SessionStart).toContain("legacy");
    expect(
      settings.hooks.SessionStart.some(
        (group: unknown) =>
          typeof group === "object" &&
          group !== null &&
          "hooks" in group &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (hook: unknown) =>
              typeof hook === "object" &&
              hook !== null &&
              "command" in hook &&
              hook.command === 42,
          ),
      ),
    ).toBe(true);
  });
  it("classifies unreadable settings as FILE_ERROR, not absent or UNKNOWN", () => {
    const result = run(["setup", "uninstall"], {
      claudeSettings: "{}",
      claudeSettingsMode: 0o000,
    });
    try {
      expect(result.exitCode, outcome(result)).toBe(1);
      expect(result.stdout, outcome(result)).toContain("code: FILE_ERROR");
    } finally {
      chmodSync(join(result.home, ".claude", "settings.json"), 0o600);
    }
  });

  it("reports denied uninstall and verifies successful removal without losing unrelated hooks", () => {
    const installed = run(["setup", "hooks"], {
      claudeSettings: JSON.stringify({ keep: true }),
    });
    expect(installed.exitCode, outcome(installed)).toBe(0);
    const codex = join(installed.home, ".codex", "hooks.json");
    chmodSync(codex, 0o400);
    const denied = run(["setup", "uninstall"], { home: installed.home });
    expect(denied.exitCode, outcome(denied)).toBe(1);
    expect(denied.stdout, outcome(denied)).toContain("code: SETUP_FAILED");
    expect(readFileSync(codex, "utf8")).toContain("argo-workflows-axi");
    chmodSync(codex, 0o600);
    const removed = run(["setup", "uninstall"], { home: installed.home });
    expect(removed.exitCode, outcome(removed)).toBe(0);
    expect(removed.stdout, outcome(removed)).toContain("session_end: absent");
    const settings = JSON.parse(
      readFileSync(join(installed.home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.keep).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("# argo-workflows-axi");
    expect(readFileSync(codex, "utf8")).not.toContain("argo-workflows-axi");
    const again = run(["setup", "uninstall"], { home: installed.home });
    expect(again.exitCode, outcome(again)).toBe(0);
  });
  it.each([
    ["read-only Codex hooks", { readonlyCodex: true }],
    ["read-only OpenCode config", { readonlyConfig: true }],
  ])("reports %s as a structured failure", (_name, options) => {
    const result = run(["setup", "hooks"], options);
    expect(result.exitCode, outcome(result)).toBe(1);
    expect(result.stdout, outcome(result)).toContain("code: SETUP_FAILED");
    expect(result.stdout, outcome(result)).toContain("Hook setup failed");
    expect(result.stdout, outcome(result)).toContain(
      _name === "read-only Codex hooks" ? "codex" : "opencode",
    );
    expect(result.stdout, outcome(result)).toContain("EACCES");
  });

  it("reports all failed writes with every affected agent and file", () => {
    const result = run(["setup", "hooks"], {
      readonlyClaude: true,
      readonlyCodex: true,
      readonlyConfig: true,
    });
    expect(result.exitCode, outcome(result)).toBe(1);
    expect(result.stdout, outcome(result)).toContain("code: SETUP_FAILED");
    for (const agent of ["claude", "codex", "opencode"]) {
      expect(result.stdout, outcome(result)).toContain(agent);
    }
    expect(result.stdout, outcome(result)).toContain(".codex/hooks.json");
    expect(result.stdout, outcome(result)).toContain(
      ".config/opencode/plugins",
    );
    expect(result.stdout, outcome(result)).toContain(".claude/settings.json");
  });

  it("continues uninstalling other hooks when Codex cannot be read", () => {
    const installed = run(["setup", "hooks"]);
    expect(installed.exitCode, outcome(installed)).toBe(0);
    const plugin = join(
      installed.home,
      ".config",
      "opencode",
      "plugins",
      "axi-argo-workflows-axi.js",
    );
    expect(existsSync(plugin)).toBe(true);
    const codex = join(installed.home, ".codex", "hooks.json");
    chmodSync(codex, 0o000);
    try {
      const result = run(["setup", "uninstall"], { home: installed.home });
      expect(result.exitCode, outcome(result)).toBe(1);
      expect(result.stdout, outcome(result)).toContain("code: SETUP_FAILED");
      expect(result.stdout, outcome(result)).toContain(codex);
      expect(
        readFileSync(join(installed.home, ".claude", "settings.json"), "utf8"),
      ).not.toContain("argo-workflows-axi");
      expect(existsSync(plugin)).toBe(false);
    } finally {
      chmodSync(codex, 0o600);
    }
    expect(readFileSync(codex, "utf8")).toContain("argo-workflows-axi");
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
    const sessionStartCommand = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain("axi installed package");
    expect(command).toContain("' context end # argo-workflows-axi");
    expect(sessionStartCommand.startsWith("'")).toBe(true);
    expect(sessionStartCommand.endsWith("'")).toBe(true);
    for (const hookCommand of [command, sessionStartCommand]) {
      const invoked = spawnSync("/bin/sh", ["-c", hookCommand], {
        env: { ...process.env, HOME: result.home },
        encoding: "utf8",
      });
      expect(invoked.status, invoked.stderr).toBe(0);
    }
  });
});
