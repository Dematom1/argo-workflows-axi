import {
  existsSync,
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
examples[1]:
  argo-workflows-axi setup hooks
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
    throw axiError(`Could not read Claude settings at ${path}`, "UNKNOWN");
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
    );
  const groups = settings.hooks.SessionEnd;
  if (groups === undefined) return [];
  if (
    !Array.isArray(groups) ||
    groups.some(
      (group) =>
        typeof group !== "object" || group === null || Array.isArray(group),
    )
  )
    throw axiError(
      "Claude settings hooks.SessionEnd must be an array of groups",
      "VALIDATION_ERROR",
    );
  return groups as Group[];
}
function writeSettings(path: string, settings: Settings): void {
  const dir = dirname(path);
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
      ...(mode === undefined ? {} : { mode }),
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function hookStatus(wasInstalled: boolean, isInstalled: boolean): string {
  return wasInstalled
    ? "already installed"
    : isInstalled
      ? "installed"
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
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const markerCommand = `argo-workflows-axi context end # ${MARKER}`;
  if (sub === "uninstall") {
    const initial = readSettings(settingsPath);
    validateSessionEnd(initial);
    uninstallSessionStartHooks({ marker: MARKER, scope: "user" });
    const settings = readSettings(settingsPath);
    const groups = validateSessionEnd(settings);
    if (settings.hooks) {
      const remaining = groups.flatMap((group) => {
        if (!Array.isArray(group.hooks)) return [group];
        const kept = (group.hooks as Hook[]).filter(
          (hook) => !hook.command?.includes(markerCommand),
        );
        return kept.length ? [{ ...group, hooks: kept }] : [];
      });
      if (remaining.length) settings.hooks.SessionEnd = remaining;
      else delete settings.hooks.SessionEnd;
    }
    writeSettings(settingsPath, settings);
    return { setup: "hooks uninstalled", scope: "user" };
  }

  const settings = readSettings(settingsPath);
  const groups = validateSessionEnd(settings);
  const before = sessionStartHookStatus({ marker: MARKER, scope: "user" });
  const errors: string[] = [];
  installSessionStartHooks({
    marker: MARKER,
    execPath: ctxEntrypoint(),
    binaryNames: [CTX_BIN],
    distEntrypoints: [`dist/bin/${CTX_BIN}.js`],
    scope: "user",
    onError: (message) => errors.push(message),
  });
  const installedSettings = readSettings(settingsPath);
  const installedGroups = validateSessionEnd(installedSettings);
  installedSettings.hooks ??= {};
  const retained = installedGroups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    const kept = (group.hooks as Hook[]).filter(
      (hook) => !hook.command?.includes(`# ${MARKER}`),
    );
    return kept.length ? [{ ...group, hooks: kept }] : [];
  });
  retained.push({
    matcher: "",
    hooks: [{ type: "command", command: markerCommand, timeout: 10 }],
  });
  installedSettings.hooks.SessionEnd = retained;
  writeSettings(settingsPath, installedSettings);
  const status = sessionStartHookStatus({ marker: MARKER, scope: "user" });
  const out: Record<string, unknown> = {
    setup:
      errors.length === 0
        ? "hooks installed or already up to date"
        : "hooks partially installed",
    scope: "user",
    runs: `${CTX_BIN} (offline - no network or credentials)`,
    claude: hookStatus(before.claude.installed, status.claude.installed),
    codex: hookStatus(before.codex.installed, status.codex.installed),
    opencode: hookStatus(before.opencode.installed, status.opencode.installed),
    session_end: "installed",
  };
  if (errors.length) out.errors = errors;
  return out;
}
