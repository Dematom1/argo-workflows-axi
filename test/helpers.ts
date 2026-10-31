import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeCli = join(root, "test", "fixtures", "fake-cli.mjs");
export const BIN = join(root, "dist", "bin", "argo-workflows-axi.js");
export const CTX_BIN = join(root, "dist", "bin", "argo-workflows-axi-ctx.js");

export interface FakeResponse {
  bin?: "argo" | "kubectl";
  match?: string[];
  stdout?: string;
  stderr?: string;
  exit?: number;
  times?: number;
  sleepMs?: number;
  /** Overwrite this file with these contents when the response is used. */
  writeFile?: [string, string];
}

export interface Call {
  bin: string;
  argv: string[];
  argoServerEnv: string | null;
  /** Contents of absolute-path file arguments, read while the call ran. */
  files: Record<string, string>;
}

export interface RunOptions {
  responses?: FakeResponse[];
  env?: Record<string, string>;
  stdin?: string;
  /** Contents of ~/.config/argo-workflows-axi/config.json (object is JSON-encoded). */
  config?: unknown;
  /** Omit the fake kubectl (simulates kubectl missing). */
  noKubectl?: boolean;
  bin?: string;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
  calls: Call[];
  home: string;
}

/** Default kubeconfig answers: context kind-dev, namespace argo. */
export const KUBE_DEFAULTS: FakeResponse[] = [
  { bin: "kubectl", match: ["current-context"], stdout: "kind-dev\n" },
  { bin: "kubectl", match: ["view", "--minify"], stdout: "argo" },
];

const fakeBins = new Map<boolean, string>();

/**
 * One fake-bin directory per test worker and kubectl variant. The shims take
 * the scenario and log paths from the environment, so they can be shared;
 * creating fresh executables for every run is slow on macOS, which inspects
 * each new executable on first launch.
 */
function fakeBinDir(noKubectl: boolean): string {
  const existing = fakeBins.get(noKubectl);
  if (existing) return existing;
  const fakeBin = mkdtempSync(join(tmpdir(), "awf-axi-bin-"));
  for (const name of noKubectl ? ["argo"] : ["argo", "kubectl"]) {
    if (process.platform === "win32") {
      writeFileSync(
        join(fakeBin, `${name}.cmd`),
        `@"${process.execPath}" "${fakeCli}" ${name} %*\r\n`,
      );
    } else {
      const shim = join(fakeBin, name);
      writeFileSync(
        shim,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" ${name} "$@"\n`,
      );
      chmodSync(shim, 0o755);
    }
  }
  if (process.platform !== "win32")
    symlinkSync(process.execPath, join(fakeBin, "node"));
  fakeBins.set(noKubectl, fakeBin);
  return fakeBin;
}

/**
 * Run the built CLI hermetically: PATH is one temp dir holding only the fake
 * argo/kubectl shims and a `node` symlink, so no real binary is reachable;
 * HOME, XDG_CONFIG_HOME, the scenario and the call log are fresh per run,
 * KUBECONFIG points nowhere, and no ARGO_* variable leaks in from the
 * developer's shell.
 */
export function run(args: string[], options: RunOptions = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "awf-axi-test-"));
  const fakeBin = fakeBinDir(options.noKubectl ?? false);
  const home = join(dir, "home");
  mkdirSync(home);

  const configHome = join(home, ".config");
  if (options.config !== undefined) {
    mkdirSync(join(configHome, "argo-workflows-axi"), { recursive: true });
    writeFileSync(
      join(configHome, "argo-workflows-axi", "config.json"),
      typeof options.config === "string"
        ? options.config
        : JSON.stringify(options.config),
    );
  }
  const scenario = join(dir, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({ responses: options.responses ?? [] }),
  );
  const log = join(dir, "calls.jsonl");

  const env: Record<string, string> = {
    PATH: fakeBin,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    KUBECONFIG: join(dir, "no-kubeconfig"),
    FAKE_SCENARIO: scenario,
    FAKE_LOG: log,
    ...options.env,
  };

  const result = spawnSync(process.execPath, [options.bin ?? BIN, ...args], {
    env,
    input: options.stdin ?? "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
    : [];
  return { stdout: result.stdout, exitCode: result.status ?? -1, calls, home };
}

export function argoCalls(result: RunResult): string[][] {
  return result.calls.filter((c) => c.bin === "argo").map((c) => c.argv);
}

const WRITE_VERBS = new Set([
  "submit",
  "retry",
  "resubmit",
  "stop",
  "terminate",
  "suspend",
  "resume",
  "delete",
]);

/** argo invocations that would change something (cron suspend/resume included). */
export function writeCalls(result: RunResult): string[][] {
  return argoCalls(result).filter((argv) =>
    argv[0] === "cron" ? WRITE_VERBS.has(argv[1]) : WRITE_VERBS.has(argv[0]),
  );
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
