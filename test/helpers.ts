import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
}

export interface Call {
  bin: string;
  argv: string[];
  argoServerEnv: string | null;
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

/**
 * Run the built CLI hermetically: PATH holds only the fake argo/kubectl and
 * node, HOME and XDG_CONFIG_HOME are fresh temp dirs, KUBECONFIG points
 * nowhere, and no ARGO_* variable leaks in from the developer's shell.
 */
export function run(args: string[], options: RunOptions = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "awf-axi-test-"));
  const fakeBin = join(dir, "bin");
  mkdirSync(fakeBin);
  const names = options.noKubectl ? ["argo"] : ["argo", "kubectl"];
  for (const name of names) {
    const shim = join(fakeBin, name);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" ${name} "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
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
    PATH: `${fakeBin}:${dirname(process.execPath)}`,
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
