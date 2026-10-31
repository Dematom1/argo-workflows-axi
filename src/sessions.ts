import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionRecord {
  cwd: string;
  commands: Record<string, number>;
  target?: string;
  namespace?: string;
  ended_at: string;
}

const SESSION_COMMANDS = new Set([
  "ctx",
  "triage",
  "wf",
  "cron",
  "template",
  "clustertemplate",
  "archive",
  "setup",
  "update",
]);
export function sessionsPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "argo-workflows-axi",
    "sessions.json",
  );
}

export function readSessions(): SessionRecord[] {
  try {
    const value: unknown = JSON.parse(readFileSync(sessionsPath(), "utf8"));
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is SessionRecord =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.cwd === "string" &&
            typeof entry.commands === "object" &&
            entry.commands !== null &&
            typeof entry.ended_at === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function recordSession(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const input = payload as { transcript_path?: unknown; cwd?: unknown };
  if (
    typeof input.transcript_path !== "string" ||
    typeof input.cwd !== "string"
  )
    return;
  let transcript: string;
  try {
    transcript = readFileSync(input.transcript_path, "utf8");
  } catch {
    return;
  }
  const commands: Record<string, number> = {};
  const targets = new Map<string, number>();
  const namespaces = new Map<string, number>();
  for (const line of transcript.split(/\r?\n/)) {
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null) continue;
      const message = (entry as { message?: unknown }).message;
      const content =
        typeof message === "object" && message !== null
          ? (message as { content?: unknown }).content
          : undefined;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (
          typeof part !== "object" ||
          part === null ||
          (part as { type?: unknown }).type !== "tool_use"
        )
          continue;
        const tool = part as { name?: unknown; input?: unknown };
        if (
          tool.name !== "Bash" ||
          typeof tool.input !== "object" ||
          tool.input === null
        )
          continue;
        const command = (tool.input as { command?: unknown }).command;
        if (typeof command !== "string") continue;
        const match =
          /(?:^|\/)argo-workflows-axi(?:\s+)(ctx|triage|wf|cron|template|clustertemplate|archive|setup|update)(?=\s|$)/.exec(
            command,
          );
        if (!match || !SESSION_COMMANDS.has(match[1])) continue;
        commands[match[1]] = (commands[match[1]] ?? 0) + 1;
        const context = /(?:^|\s)--context(?:=|\s+)([^\s]+)/.exec(command)?.[1];
        const ns = /(?:^|\s)(?:-n|--namespace)(?:=|\s+)([^\s]+)/.exec(
          command,
        )?.[1];
        if (context) targets.set(context, (targets.get(context) ?? 0) + 1);
        if (ns) namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1);
      }
    } catch {
      /* Ignore non-JSON transcript lines. */
    }
  }
  const mostUsed = (counts: Map<string, number>) =>
    [...counts].reduce<[string, number] | undefined>(
      (best, entry) => (!best || entry[1] > best[1] ? entry : best),
      undefined,
    )?.[0];
  const target = mostUsed(targets);
  const namespace = mostUsed(namespaces);
  const path = sessionsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2000;
  let locked = false;
  while (!locked && Date.now() < deadline) {
    try {
      writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });
      locked = true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath);
      } catch {
        // Lock disappeared while checking staleness.
      }
      if (!locked) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (!locked) return;
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const current = readSessions().filter((session) => session.cwd !== input.cwd);
    current.push({
      cwd: input.cwd,
      commands,
      ...(target ? { target } : {}),
      ...(namespace ? { namespace } : {}),
      ended_at: new Date().toISOString(),
    });
    writeFileSync(tempPath, JSON.stringify(current.slice(-100)), { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
    rmSync(lockPath, { force: true });
  }
}

export function lastSession(cwd = process.cwd()): SessionRecord | undefined {
  return readSessions().find((session) => session.cwd === cwd);
}
