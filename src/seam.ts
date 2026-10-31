import { execFile } from "node:child_process";
import { axiError, mapArgoFailure } from "./errors.js";
import { isApprovalFor, type WriteApproval } from "./approval.js";
import {
  OPERATIONS,
  type Operation,
  type OperationId,
  type ReadOperationId,
  type WriteOperationId,
} from "./registry.js";

/**
 * The single read-only seam (design S5). This is the only module that spawns
 * processes. Every invocation names a registered operation; its subcommand is
 * fixed by the registry, every flag must be declared for that operation, and
 * write operations additionally need an approval minted by the write gate.
 */

export interface TargetArgs {
  context?: string;
  server?: string;
  namespace?: string;
}

export interface ExecOptions {
  target?: TargetArgs;
  /** Hard bound on the subprocess; it is killed when exceeded. */
  timeoutMs?: number;
  /** Remove these variables from the child environment (e.g. ARGO_SERVER for offline calls). */
  unsetEnv?: string[];
  /** Resolve (instead of reject) when the command exits non-zero, e.g. lint findings. */
  allowFailure?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 512 * 1024 * 1024;

function validateArgs(id: OperationId, op: Operation, args: string[]): void {
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      continue;
    }
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!(op.flags as readonly string[]).includes(name)) {
      throw new Error(
        `seam: flag ${name} is not registered for operation ${id}`,
      );
    }
  }
}

function buildArgv(
  op: Operation,
  args: string[],
  target?: TargetArgs,
): string[] {
  const argv = [...op.command, ...args];
  if (op.targeted && target) {
    if (target.context) argv.push(`--context=${target.context}`);
    if (target.server) argv.push(`--argo-server=${target.server}`);
    if (target.namespace) argv.push(`--namespace=${target.namespace}`);
  }
  if (op.bin === "argo") {
    argv.push("--loglevel=error");
  }
  return argv;
}

function spawn(
  op: Operation,
  argv: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const env = { ...process.env };
  if (!env.ARGO_SERVER?.trim()) delete env.ARGO_SERVER;
  for (const name of options.unsetEnv ?? []) {
    delete env[name];
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = execFile(
      op.bin,
      argv,
      {
        env,
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string;
        };
        if (err.code === "ENOENT") {
          reject(
            op.bin === "argo"
              ? axiError(
                  "The argo CLI is not installed or not on PATH",
                  "ARGO_NOT_INSTALLED",
                  [
                    "Ask the user to install the Argo Workflows CLI: https://github.com/argoproj/argo-workflows/releases",
                  ],
                )
              : axiError(
                  "kubectl is not installed or not on PATH",
                  "ARGO_NOT_INSTALLED",
                  [
                    "Ask the user to install kubectl to resolve the current Kubernetes context",
                  ],
                ),
          );
          return;
        }
        if (err.killed || err.signal === "SIGKILL") {
          reject(
            axiError(
              `${op.bin} ${op.command.join(" ")} did not finish within ${Math.round(timeoutMs / 1000)}s`,
              "TIMEOUT",
              [
                "Run `argo-workflows-axi ctx` to check the target",
                "Ask the user whether the cluster or Argo Server is reachable",
              ],
            ),
          );
          return;
        }
        const exitCode = typeof err.code === "number" ? err.code : 1;
        if (options.allowFailure) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(mapArgoFailure(String(stderr || stdout || err.message)));
      },
    );
    child.stdin?.end();
  });
}

/** Run a read or local operation. */
export function runRead(
  id: ReadOperationId,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const op: Operation = OPERATIONS[id];
  if (op.tier === "write") {
    throw new Error(`seam: ${id} is a write operation`);
  }
  validateArgs(id, op, args);
  return spawn(op, buildArgv(op, args, options.target), options);
}

/** Run a write operation. Requires an approval minted by the write gate. */
export function runWrite(
  id: WriteOperationId,
  args: string[],
  approval: WriteApproval,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const op: Operation = OPERATIONS[id];
  if (op.tier !== "write") {
    throw new Error(`seam: ${id} is not a write operation`);
  }
  if (!isApprovalFor(approval, id)) {
    throw new Error(`seam: ${id} was called without a write-gate approval`);
  }
  validateArgs(id, op, args);
  return spawn(op, buildArgv(op, args, options.target), {
    timeoutMs: 60_000,
    ...options,
  });
}

/** Parse one or more JSON documents printed back to back (argo `get A B -o json`). */
export function parseJsonStream(text: string): unknown[] {
  const docs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        docs.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return docs;
}

export function parseJson<T>(text: string, what: string): T {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "null") {
    return [] as unknown as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw axiError(
      `argo returned output that is not JSON for ${what}`,
      "UNKNOWN",
      [
        "Run `argo-workflows-axi ctx` to check the argo CLI version is supported",
      ],
    );
  }
}
