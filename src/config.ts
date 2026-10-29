import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { axiError } from "./errors.js";
import type { Target } from "./target.js";

/**
 * The local write-target allowlist (design S3). Writes run only against
 * targets listed here; a missing file means no target is writable. No command
 * writes this file: a human edits it, so an agent cannot opt itself in.
 *
 * {
 *   "writableTargets": [
 *     { "context": "kind-dev", "namespace": "argo" },
 *     { "server": "localhost:2746", "namespace": "*" }
 *   ]
 * }
 */

export interface WritableTarget {
  context?: string;
  server?: string;
  namespace: string;
}

export interface ToolConfig {
  writableTargets: WritableTarget[];
}

export function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "argo-workflows-axi", "config.json");
}

export function displayConfigPath(): string {
  const path = configPath();
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function invalid(detail: string): never {
  throw axiError(
    `Invalid config ${displayConfigPath()}: ${detail}`,
    "CONFIG_INVALID",
    [
      'Ask the user to fix the file; expected {"writableTargets":[{"context":"<kube-context>","namespace":"<ns>"}]}',
    ],
  );
}

export function loadConfig(): ToolConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { writableTargets: [] };
    }
    invalid((error as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    invalid(`not valid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("top level must be an object");
  }
  const list = (parsed as { writableTargets?: unknown }).writableTargets ?? [];
  if (!Array.isArray(list)) {
    invalid("writableTargets must be an array");
  }

  const writableTargets = list.map((entry, index): WritableTarget => {
    if (typeof entry !== "object" || entry === null) {
      invalid(`writableTargets[${index}] must be an object`);
    }
    const { context, server, namespace } = entry as Record<string, unknown>;
    const hasContext = typeof context === "string" && context.length > 0;
    const hasServer = typeof server === "string" && server.length > 0;
    if (hasContext === hasServer) {
      invalid(
        `writableTargets[${index}] needs exactly one of "context" or "server"`,
      );
    }
    if (typeof namespace !== "string" || namespace.length === 0) {
      invalid(`writableTargets[${index}].namespace must be a namespace or "*"`);
    }
    return hasContext
      ? { context: context as string, namespace }
      : { server: server as string, namespace };
  });

  return { writableTargets };
}

export function isWritable(config: ToolConfig, target: Target): boolean {
  return config.writableTargets.some((entry) => {
    const nsMatches =
      entry.namespace === "*" || entry.namespace === target.namespace;
    if (!nsMatches) return false;
    if (target.mode === "argo-server") {
      return entry.server !== undefined && entry.server === target.server;
    }
    return entry.context !== undefined && entry.context === target.context;
  });
}
