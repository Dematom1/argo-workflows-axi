import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { installSessionStartHooks, sessionStartHookStatus } from "axi-sdk-js";
import { hasFlag, parseArgs, requirePositionals } from "../args.js";
import { axiError } from "../errors.js";

/**
 * `setup hooks`: explicit opt-in to SessionStart context (AXI principle 7).
 * The hook runs the separate `argo-workflows-axi-ctx` entrypoint, which is the
 * offline `ctx` view (design S17): session start never touches the network.
 */

export const SETUP_HELP = `command: argo-workflows-axi setup hooks
description: Install or repair SessionStart hooks (Claude Code, Codex, OpenCode) that show the offline ctx view at session start
flags:
  --project: Install into the current repository instead of your user config
  --status: Report whether hooks are installed, without writing
examples[3]:
  argo-workflows-axi setup hooks
  argo-workflows-axi setup hooks --project
  argo-workflows-axi setup hooks --status
`;

const MARKER = "argo-workflows-axi";
const CTX_BIN = "argo-workflows-axi-ctx";

function ctxEntrypoint(): string {
  const main = realpathSync(process.argv[1] ?? "");
  const candidate = join(dirname(main), `${CTX_BIN}.js`);
  if (!existsSync(candidate)) {
    throw axiError(
      `Could not find the ${CTX_BIN} entrypoint next to ${main}`,
      "UNKNOWN",
      ["Reinstall with `npm install -g argo-workflows-axi`"],
    );
  }
  return candidate;
}

export async function setupCommand(
  args: string[],
): Promise<Record<string, unknown> | string> {
  if (args.includes("--help") || args.length === 0) return SETUP_HELP;
  const usage = "argo-workflows-axi setup hooks";
  const parsed = parseArgs(args, { bool: ["--project", "--status"] }, usage);
  const [sub] = requirePositionals(parsed, 1, 1, usage);
  if (sub !== "hooks") {
    throw axiError(`Unknown setup command: ${sub}`, "VALIDATION_ERROR", [
      `Run \`${usage}\``,
    ]);
  }
  const scope = hasFlag(parsed, "--project") ? "project" : "user";

  if (hasFlag(parsed, "--status")) {
    const status = sessionStartHookStatus({ marker: MARKER, scope });
    return {
      scope,
      claude: status.claude.installed
        ? `installed (${status.claude.path})`
        : "not installed",
      codex: status.codex.installed
        ? `installed (${status.codex.path})`
        : "not installed",
      opencode: status.opencode.installed
        ? `installed (${status.opencode.path})`
        : "not installed",
    };
  }

  const errors: string[] = [];
  const execPath = ctxEntrypoint();
  installSessionStartHooks({
    marker: MARKER,
    execPath,
    binaryNames: [CTX_BIN],
    distEntrypoints: [`dist/bin/${CTX_BIN}.js`],
    scope,
    onError: (message) => errors.push(message),
  });
  const status = sessionStartHookStatus({ marker: MARKER, scope });
  const out: Record<string, unknown> = {
    setup:
      errors.length === 0
        ? "hooks installed or already up to date"
        : "hooks partially installed",
    scope,
    runs: `${CTX_BIN} (offline - no network or credentials)`,
    claude: status.claude.installed ? "installed" : "not installed",
    codex: status.codex.installed ? "installed" : "not installed",
    opencode: status.opencode.installed ? "installed" : "not installed",
  };
  if (errors.length > 0) out.errors = errors;
  return out;
}
