import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
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
type Group = { hooks?: Hook[]; matcher?: string; [key: string]: unknown };
type Hook = { command?: string; [key: string]: unknown };
function readSettings(path: string): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Settings : {};
  } catch { return {}; }
}
function ctxEntrypoint(): string {
  const main = realpathSync(process.argv[1] ?? "");
  const candidate = join(dirname(main), `${CTX_BIN}.js`);
  if (!existsSync(candidate)) throw axiError(`Could not find the ${CTX_BIN} entrypoint next to ${main}`, "UNKNOWN", ["Reinstall with `npm install -g argo-workflows-axi`"]);
  return candidate;
}

export async function setupCommand(args: string[]): Promise<Record<string, unknown> | string> {
  if (args.includes("--help") || args.length === 0) return SETUP_HELP;
  const usage = "argo-workflows-axi setup hooks|uninstall";
  const parsed = parseArgs(args, {}, usage);
  const [sub] = requirePositionals(parsed, 1, 1, usage);
  if (sub !== "hooks" && sub !== "uninstall") throw axiError(`Unknown setup command: ${sub}`, "VALIDATION_ERROR", [`Run \`${usage}\``]);
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const markerCommand = `argo-workflows-axi context end # ${MARKER}`;
  if (sub === "uninstall") {
    uninstallSessionStartHooks({ marker: MARKER, scope: "user" });
    const settings = readSettings(settingsPath);
    const hooks = settings.hooks;
    const groups = hooks?.SessionEnd;
    if (Array.isArray(groups)) {
      const remaining = (groups as Group[]).map((group) => ({ ...group, hooks: group.hooks?.filter((hook) => !hook.command?.includes(markerCommand)) })).filter((group) => group.hooks?.length);
      if (hooks) {
        if (remaining.length) hooks.SessionEnd = remaining;
        else delete hooks.SessionEnd;
      }
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    chmodSync(settingsPath, 0o600);
    return { setup: "hooks uninstalled", scope: "user" };
  }

  const errors: string[] = [];
  installSessionStartHooks({ marker: MARKER, execPath: ctxEntrypoint(), binaryNames: [CTX_BIN], distEntrypoints: [`dist/bin/${CTX_BIN}.js`], scope: "user", onError: (message) => errors.push(message) });
  const settings = readSettings(settingsPath);
  settings.hooks ??= {};
  const groups = settings.hooks.SessionEnd;
  const retained = (Array.isArray(groups) ? groups as Group[] : []).map((group) => ({ ...group, hooks: group.hooks?.filter((hook) => !hook.command?.includes(`# ${MARKER}`)) })).filter((group) => group.hooks?.length);
  retained.push({ matcher: "", hooks: [{ type: "command", command: markerCommand, timeout: 10 }] });
  settings.hooks.SessionEnd = retained;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
  const status = sessionStartHookStatus({ marker: MARKER, scope: "user" });
  const out: Record<string, unknown> = {
    setup: errors.length === 0 ? "hooks installed or already up to date" : "hooks partially installed",
    scope: "user",
    runs: `${CTX_BIN} (offline - no network or credentials)`,
    claude: status.claude.installed ? "installed" : "not installed",
    codex: status.codex.installed ? "installed" : "not installed",
    opencode: status.opencode.installed ? "installed" : "not installed",
    session_end: "installed",
  };
  if (errors.length) out.errors = errors;
  return out;
}
