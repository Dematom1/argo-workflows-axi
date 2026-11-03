import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { parseArgs, requirePositionals } from "../args.js";
import { axiError } from "../errors.js";

export const SETUP_HELP = `command: argo-workflows-axi setup hooks
description: Install or repair session hooks, including Claude Code SessionEnd memory
examples[2]:
  - argo-workflows-axi setup hooks
  - argo-workflows-axi setup uninstall
`;

const MARKER = "argo-workflows-axi";
const CTX_BIN = "argo-workflows-axi-ctx";
type Settings = { hooks?: Record<string, unknown> } & Record<string, unknown>;
type Group = { hooks?: unknown; matcher?: string; [key: string]: unknown };
type Hook = { command?: string; [key: string]: unknown };
function readSettings(path: string): Settings {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw axiError(`Could not read Claude settings at ${path}`, "FILE_ERROR", [
      `Check permissions with chmod u+rw '${path}', then retry setup`,
    ]);
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Expected settings object");
    return parsed as Settings;
  } catch {
    throw axiError(
      `Could not parse Claude settings at ${path}`,
      "VALIDATION_ERROR",
      ["Fix the JSON syntax in Claude settings.json and retry"],
    );
  }
}
function validateSessionEnd(settings: Settings): Group[] {
  if (settings.hooks === undefined) return [];
  if (
    typeof settings.hooks !== "object" ||
    settings.hooks === null ||
    Array.isArray(settings.hooks)
  )
    throw axiError(
      "Claude settings hooks must be an object",
      "VALIDATION_ERROR",
      ["Edit Claude settings.json so hooks is a JSON object, then retry"],
    );
  const groups = settings.hooks.SessionEnd;
  if (groups === undefined) return [];
  if (
    !Array.isArray(groups) ||
    groups.some(
      (group) =>
        typeof group !== "object" ||
        group === null ||
        Array.isArray(group) ||
        (Array.isArray(group.hooks) &&
          group.hooks.some(
            (hook: unknown) =>
              typeof hook !== "object" ||
              hook === null ||
              Array.isArray(hook) ||
              ("command" in hook && typeof hook.command !== "string"),
          )),
    )
  )
    throw axiError(
      "Claude settings hooks.SessionEnd must be an array of groups",
      "VALIDATION_ERROR",
      ["Fix hooks.SessionEnd in Claude settings.json, then retry setup"],
    );
  return groups as Group[];
}
function writeSettings(path: string, settings: Settings): void {
  let destination = path;
  try {
    if (lstatSync(path).isSymbolicLink()) destination = realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const dir = dirname(destination);
  mkdirSync(dir, { recursive: true });
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const temp = join(dir, `.settings-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", {
      flag: "wx",
    });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, destination);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function hookStatus(wasInstalled: boolean, isInstalled: boolean): string {
  return isInstalled
    ? wasInstalled
      ? "already installed"
      : "installed"
    : "stale";
}
function ctxEntrypoint(): string {
  const main = realpathSync(process.argv[1] ?? "");
  const candidate = join(dirname(main), `${CTX_BIN}.js`);
  if (!existsSync(candidate))
    throw axiError(
      `Could not find the ${CTX_BIN} entrypoint next to ${main}`,
      "UNKNOWN",
      ["Reinstall with `npm install -g argo-workflows-axi`"],
    );
  return candidate;
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function sessionEndCommand(): string {
  return `${shellQuote(realpathSync(process.argv[1] ?? ""))} context end # ${MARKER}`;
}
function agentForError(message: string): string {
  if (message.includes("/.claude/")) return "claude";
  if (message.includes("/.codex/")) return "codex";
  if (message.includes("/.config/opencode/")) return "opencode";
  return "unknown";
}

export async function setupCommand(
  args: string[],
): Promise<Record<string, unknown> | string> {
  if (args.includes("--help") || args.length === 0) return SETUP_HELP;
  const usage = "argo-workflows-axi setup hooks|uninstall";
  const parsed = parseArgs(args, {}, usage);
  const [sub] = requirePositionals(parsed, 1, 1, usage);
  if (sub !== "hooks" && sub !== "uninstall")
    throw axiError(`Unknown setup command: ${sub}`, "VALIDATION_ERROR", [
      `Run \`${usage}\``,
    ]);
  const settingsPath = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
  const markerCommand = sessionEndCommand();
  if (sub === "uninstall") {
    const initial = readSettings(settingsPath);
    validateSessionEnd(initial);
    const errors: string[] = [];
    const before = sessionStartHookStatus({ marker: MARKER, scope: "user" });
    for (const { path } of [before.codex, before.opencode]) {
      try {
        readFileSync(path);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          errors.push(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    }
    uninstallSessionStartHooks({
      marker: MARKER,
      scope: "user",
      onError: (message) => errors.push(message),
    });
    const settings = readSettings(settingsPath);
    const groups = validateSessionEnd(settings);
    if (settings.hooks) {
      const remaining = groups.flatMap((group) => {
        if (!Array.isArray(group.hooks)) return [group];
        const hooks = group.hooks as Hook[];
        const kept = hooks.filter(
          (hook) => !hook.command?.includes(`# ${MARKER}`),
        );
        return kept.length || hooks.length === 0
          ? [{ ...group, hooks: kept }]
          : [];
      });
      if (remaining.length) settings.hooks.SessionEnd = remaining;
      else delete settings.hooks.SessionEnd;
    }
    try {
      writeSettings(settingsPath, settings);
    } catch (error) {
      errors.push(
        `${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const status = sessionStartHookStatus({ marker: MARKER, scope: "user" });
    const sessionEndRemains = validateSessionEnd(
      readSettings(settingsPath),
    ).some(
      (group) =>
        Array.isArray(group.hooks) &&
        group.hooks.some((hook) => hook.command?.includes(`# ${MARKER}`)),
    );
    const remaining = [
      status.claude.installed,
      status.codex.installed,
      status.opencode.installed,
      sessionEndRemains,
    ].some(Boolean);
    if (errors.length || remaining)
      throw axiError(
        `Hook uninstall failed${errors.length ? `; file errors: ${errors.join("; ")}` : "; managed hooks remain"}`,
        "SETUP_FAILED",
        [
          "Check file and directory permissions for Claude, Codex, and OpenCode settings, then rerun `argo-workflows-axi setup hooks` or `setup uninstall`",
        ],
      );
    return {
      setup: "hook removal verified",
      scope: "user",
      claude: status.claude.installed ? "still installed" : "absent",
      codex: status.codex.installed ? "still installed" : "absent",
      opencode: status.opencode.installed ? "still installed" : "absent",
      session_end: sessionEndRemains ? "still installed" : "absent",
    };
  }

  const settings = readSettings(settingsPath);
  validateSessionEnd(settings);
  const malformedSessionStart: unknown[] = [];
  const groups = settings.hooks?.SessionStart;
  if (Array.isArray(groups)) {
    settings.hooks!.SessionStart = groups.flatMap((group) => {
      if (
        typeof group !== "object" ||
        group === null ||
        Array.isArray(group) ||
        !Array.isArray(group.hooks)
      ) {
        malformedSessionStart.push(group);
        return [];
      }
      const valid = group.hooks.filter((hook: unknown) => {
        const ok =
          typeof hook === "object" &&
          hook !== null &&
          !Array.isArray(hook) &&
          (!("command" in hook) || typeof hook.command === "string");
        if (!ok) malformedSessionStart.push({ ...group, hooks: [hook] });
        return ok;
      });
      return valid.length ? [{ ...group, hooks: valid }] : [];
    });
    writeSettings(settingsPath, settings);
  }
  const before = sessionStartHookStatus({ marker: MARKER, scope: "user" });
  const errors: string[] = [];
  const execPath = ctxEntrypoint();
  installSessionStartHooks({
    marker: MARKER,
    execPath,
    // Keep the resolved entrypoint absolute: a bare name may disappear outside npx's temporary PATH.
    binaryNames: [],
    distEntrypoints: [`dist/bin/${CTX_BIN}.js`],
    scope: "user",
    onError: (message) => errors.push(message),
  });
  const installedSettings = readSettings(settingsPath);
  installedSettings.hooks ??= {};
  // axi-sdk-js updates only the first matching legacy entry; discard later duplicates locally.
  const sessionStart = installedSettings.hooks?.SessionStart;
  if (Array.isArray(sessionStart)) {
    let kept = false;
    installedSettings.hooks.SessionStart = [
      ...sessionStart.flatMap((group: unknown) => {
        if (typeof group !== "object" || group === null || Array.isArray(group))
          return [group];
        const candidate = group as Group;
        if (!Array.isArray(candidate.hooks)) return [group];
        const hooks = candidate.hooks.flatMap((value: unknown) => {
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
          )
            return [value];
          const hook = value as Hook;
          if (
            typeof hook.command !== "string" ||
            !hook.command.includes(MARKER)
          )
            return [hook];
          if (kept || !hook.command.includes(execPath)) return [];
          kept = true;
          return [
            {
              ...hook,
              command:
                hook.command === execPath ? shellQuote(execPath) : hook.command,
            },
          ];
        });
        return hooks.length || candidate.hooks.length === 0
          ? [{ ...candidate, hooks }]
          : [];
      }),
      ...malformedSessionStart,
    ];
  }
  const installedGroups = validateSessionEnd(installedSettings);
  installedSettings.hooks ??= {};
  const retained = installedGroups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks as Hook[];
    const kept = hooks.filter((hook) => !hook.command?.includes(`# ${MARKER}`));
    return kept.length || hooks.length === 0 ? [{ ...group, hooks: kept }] : [];
  });
  retained.push({
    matcher: "",
    hooks: [{ type: "command", command: markerCommand, timeout: 10 }],
  });
  installedSettings.hooks.SessionEnd = retained;
  try {
    writeSettings(settingsPath, installedSettings);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`${settingsPath}: ${detail}`);
  }
  const status = sessionStartHookStatus({ marker: MARKER, scope: "user" });
  const finalSettings = readSettings(settingsPath);
  const sessionEndInstalled = validateSessionEnd(finalSettings).some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => hook.command === markerCommand),
  );
  const statuses = {
    claude: hookStatus(before.claude.installed, status.claude.installed),
    codex: hookStatus(before.codex.installed, status.codex.installed),
    opencode: hookStatus(before.opencode.installed, status.opencode.installed),
    session_end: sessionEndInstalled ? "installed" : "stale",
  };
  const failedAgents = Object.entries(statuses)
    .filter(([, value]) => value === "stale")
    .map(([agent]) => agent);
  if (errors.length || failedAgents.length) {
    throw axiError(
      `Hook setup failed for ${[...new Set([...failedAgents, ...errors.map(agentForError)])].join(", ")}${errors.length ? `; file errors: ${errors.join("; ")}` : ""}`,
      "SETUP_FAILED",
      [
        "Check file and directory permissions for Claude, Codex, and OpenCode settings, then rerun `argo-workflows-axi setup hooks`",
      ],
    );
  }
  return {
    setup: "hooks installed or already up to date",
    scope: "user",
    runs: `${CTX_BIN} (offline - no network or credentials)`,
    ...statuses,
  };
}
