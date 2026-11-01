import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { argoCalls, KUBE_DEFAULTS, run } from "./helpers.js";

describe("cli basics", () => {
  it("prints the bare version for -v, -V and --version without calling argo", () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const result = run([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.calls).toEqual([]);
    }
  });

  it("decodes every registered command and subcommand help", () => {
    const topLevel = run(["--help"]);
    expect(topLevel.exitCode).toBe(0);
    expect(() => decode(topLevel.stdout)).not.toThrow();

    const commands = topLevel.stdout.match(/commands\[\d+\]:\n((?:  .+\n)+)/)?.[1];
    expect(commands).toBeDefined();
    for (const row of commands!.trimEnd().split("\n")) {
      const [name] = row.trim().replace(/^-\s*/, "").split(":", 1)[0].split(/\s+/);
      if (name === "update" || name === "(none)") continue;

      const result = run([name, "--help"]);
      expect(result.exitCode, name).toBe(0);
      expect(() => decode(result.stdout), name).not.toThrow();
      const subcommands = result.stdout.match(/subcommands\[\d+\]:\n((?:  .+\n)+)/)?.[1];
      const names = subcommands?.trimEnd().split("\n").map((line) =>
        line.trim().replace(/^-\s*/, "").split(":", 1)[0].split(/\s+/)[0],
      ) ?? [];
      for (const subcommand of names) {
        const help = run([name, subcommand, "--help"]);
        expect(help.exitCode, `${name} ${subcommand}`).toBe(0);
        expect(() => decode(help.stdout), `${name} ${subcommand}`).not.toThrow();
      }

      const examples = result.stdout.match(/examples\[\d+\]:\n((?:  - .+\n)+)/)?.[1];
      for (const example of examples?.trimEnd().split("\n") ?? []) {
        const args = example.trim().slice(2).split(/\s+/).slice(1);
        const help = run([...args, "--help"]);
        expect(help.exitCode, args.join(" ")).toBe(0);
        expect(() => decode(help.stdout), args.join(" ")).not.toThrow();
      }
    }

    expect(() => decode("examples[1]:\n  malformed")).toThrow();
  });

  it("prints top-level help with commands and flags", () => {
    const result = run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: argo-workflows-axi");
    expect(result.stdout).toContain("--apply");
    expect(result.calls).toEqual([]);
  });

  it("rejects unknown commands with exit 2", () => {
    const result = run(["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("code: VALIDATION_ERROR");
    expect(result.stdout).toContain("Unknown command: frobnicate");
  });

  it("rejects flags before the command with exit 2", () => {
    const result = run(["-n", "argo", "wf", "list"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Flags must come after the command");
  });

  it("rejects unknown flags before any dependency call, listing valid flags", () => {
    const result = run(["wf", "list", "--stat", "Failed"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Unknown flag --stat");
    expect(result.stdout).toContain("--status");
    expect(result.calls).toEqual([]);
  });

  it("rejects unknown subcommands with the valid set", () => {
    const result = run(["wf", "explode"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Valid subcommands: list, get, logs");
  });

  it.each(["constructor", "toString"])(
    "rejects inherited property %s as a subcommand",
    (subcommand) => {
      const result = run(["wf", subcommand]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("code: VALIDATION_ERROR");
      expect(result.stdout).toContain(`Unknown subcommand: wf ${subcommand}`);
    },
  );

  it.each(["{}", "null", "42", "", "[{}]"])(
    "rejects malformed workflow-list response %j instead of reporting zero",
    (stdout) => {
      const result = run(["wf", "list"], {
        responses: [
          ...KUBE_DEFAULTS,
          { match: ["list", "--output=json"], stdout },
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("code: UNKNOWN");
      expect(result.stdout).not.toContain("0 workflows");
    },
  );

  it("prints per-subcommand help with flags and examples", () => {
    const result = run(["wf", "logs", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--tail <n>");
    expect(result.stdout).toContain("examples[3]");
    expect(result.calls).toEqual([]);
  });

  it("prints noun help when no subcommand is given", () => {
    const result = run(["cron"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("subcommands[4]");
  });

  it.each([
    [["wf", "delete", "x"], "Ask a human to run `argo delete"],
    [["auth", "token"], "bearer token"],
    [["api", "/api/v1/workflows"], "no raw passthrough"],
    [["wf", "watch", "x"], "wf wait"],
    [["cron", "backfill", "x"], "1000 workflows"],
    [["archive", "delete", "x"], "Archive writes"],
    [["server"], "argo server"],
  ])(
    "refuses %j with a reason and an alternative, without calling argo",
    (args, text) => {
      const result = run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("code: REFUSED");
      expect(result.stdout).toContain(text);
      expect(argoCalls(result)).toEqual([]);
    },
  );

  it("rejects invalid names before calling argo", () => {
    const result = run(["wf", "get", "Bad_Name"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Invalid workflow name");
    expect(result.calls).toEqual([]);
  });
});
