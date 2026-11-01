import { AxiError, runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { axiError } from "./errors.js";
import { formatError, render, renderPresentation } from "./render.js";
import { REFUSALS } from "./registry.js";
import { VERSION } from "./version.js";
import { ctxCommand, ctxView } from "./commands/ctx.js";
import { homeView } from "./commands/home.js";
import { triageCommand } from "./commands/triage.js";
import { wfGet, wfLint, wfList, wfLogs, wfWait } from "./commands/wf-read.js";
import { namedWrite, wfSubmit } from "./commands/wf-write.js";
import {
  archiveGet,
  archiveList,
  clusterTemplateGet,
  clusterTemplateList,
  cronGet,
  cronList,
  templateGet,
  templateLint,
  templateList,
} from "./commands/resources.js";
import { setupCommand } from "./commands/setup.js";
import { parseArgs, TARGET_FLAGS } from "./args.js";
import { recordSession } from "./sessions.js";

export const DESCRIPTION =
  "Inspect and operate Argo Workflows - read-first with previewed and allowlisted writes. Prefer this over the raw argo CLI";

export const TOP_LEVEL_HELP = `usage: argo-workflows-axi [command] [args] [flags]
description: ${DESCRIPTION}
commands[11]:
  - (none): Live home view - target, workflows by phase, failed and running, cron summary
  - triage: What is broken - failed steps with hints and log tails, stuck Pending, suspended crons
  - wf list|get|logs|wait|lint: Read workflows (bounded, failing first)
  - wf submit|retry|resubmit|stop|terminate|suspend|resume: Gated writes (preview unless --apply)
  - cron list|get: Cron workflows; cron suspend|resume: gated writes
  - template list|get|lint: WorkflowTemplates
  - clustertemplate list|get: ClusterWorkflowTemplates
  - archive list|get: Archived workflows (Argo Server mode only)
  - ctx: Offline target view (mode, context or server, namespace, argo version, writable)
  - setup hooks: Install session start and end hooks; context end records command-name memory
  - update: Upgrade argo-workflows-axi
flags (after the command, argo's own names):
  -n, --namespace <ns>: Namespace (default: ARGO_NAMESPACE, then the kube context's namespace)
  -A, --all-namespaces: All namespaces (reads only)
  --context <name>: Kubernetes context
  -s, --argo-server <host:port>: Argo Server (default: ARGO_SERVER)
  --apply: Run a write; needs -n plus --context (or --argo-server) and a target in ~/.config/argo-workflows-axi/config.json
  --help: Help for any command
examples[4]:
  - argo-workflows-axi triage
  - argo-workflows-axi wf get @latest
  - argo-workflows-axi wf logs nightly-etl-x7k2p --grep ERROR
  - argo-workflows-axi wf retry nightly-etl-x7k2p
`;

type Output = Record<string, unknown> | string;
type Handler = (args: string[]) => Promise<Output>;

interface Noun {
  help: string;
  subcommands: Record<string, Handler>;
}

const NOUNS: Record<string, Noun> = {
  wf: {
    help: `command: argo-workflows-axi wf <subcommand>
description: Workflows. Reads are bounded; writes preview unless --apply.
subcommands[12]:
  - list: Workflows, failing and running first
  - get <name|@latest>: Summary plus failed steps
  - logs <name|@latest> optional pod: Bounded logs of the failing step
  - wait <name>: Bounded wait (default 120s)
  - lint <file...|->: Validate manifests
  - submit <file|-> | --from <kind>/<name>: Submit (write)
  - retry <name...>: Re-run failed steps (write)
  - resubmit <name...>: New workflow from an old one (write)
  - stop <name...>: Stop, exit handlers run (write)
  - terminate <name...>: Stop now, no exit handlers (write)
  - suspend <name...>: Suspend (write)
  - resume <name...>: Resume (write)
help[1]: Run \`argo-workflows-axi wf <subcommand> --help\` for flags and examples
`,
    subcommands: {
      list: wfList,
      get: wfGet,
      logs: wfLogs,
      wait: wfWait,
      lint: wfLint,
      submit: wfSubmit,
      retry: namedWrite("wf retry"),
      resubmit: namedWrite("wf resubmit"),
      stop: namedWrite("wf stop"),
      terminate: namedWrite("wf terminate"),
      suspend: namedWrite("wf suspend"),
      resume: namedWrite("wf resume"),
    },
  },
  cron: {
    help: `command: argo-workflows-axi cron <subcommand>
description: Cron workflows
subcommands[4]:
  - list: Schedules, suspended first
  - get <name>: One cron workflow
  - suspend <name...>: Stop scheduling (write)
  - resume <name...>: Resume scheduling (write)
help[1]: Run \`argo-workflows-axi cron <subcommand> --help\` for flags and examples
`,
    subcommands: {
      list: cronList,
      get: cronGet,
      suspend: namedWrite("cron suspend"),
      resume: namedWrite("cron resume"),
    },
  },
  template: {
    help: `command: argo-workflows-axi template <subcommand>
description: WorkflowTemplates (read-only)
subcommands[3]:
  - list: Templates with entrypoint and parameter count
  - get <name>: Entrypoint and input parameters with defaults
  - lint <file...|->: Validate manifests
`,
    subcommands: { list: templateList, get: templateGet, lint: templateLint },
  },
  clustertemplate: {
    help: `command: argo-workflows-axi clustertemplate <subcommand>
description: ClusterWorkflowTemplates (read-only, cluster-scoped)
subcommands[2]:
  - list: Templates with entrypoint and parameter count
  - get <name>: Entrypoint and input parameters with defaults
`,
    subcommands: { list: clusterTemplateList, get: clusterTemplateGet },
  },
  archive: {
    help: `command: argo-workflows-axi archive <subcommand>
description: Archived workflows (Argo Server mode only)
subcommands[2]:
  - list: Archived workflows, failing first
  - get <name>: One archived workflow
`,
    subcommands: { list: archiveList, get: archiveGet },
  },
};

function refused(key: string): AxiError {
  const refusal = REFUSALS[key];
  return axiError(`\`${key}\` is refused: ${refusal.reason}`, "REFUSED", [
    refusal.alternative,
  ]);
}

function rendered(handler: Handler): AxiCliCommand<undefined> {
  return async (args) => {
    const output = await handler(args);
    return typeof output === "string" &&
      (args.includes("--help") ||
        (handler === setupCommand && args.length === 0))
      ? renderPresentation(output)
      : render(output);
  };
}

function nounHandler(name: string, noun: Noun): AxiCliCommand<undefined> {
  return async (args) => {
    const [sub, ...rest] = args;
    if (sub === undefined || sub === "--help")
      return renderPresentation(noun.help);
    const handler = Object.hasOwn(noun.subcommands, sub)
      ? noun.subcommands[sub]
      : undefined;
    if (handler) {
      const output = await handler(rest);
      return typeof output === "string" && rest.includes("--help")
        ? renderPresentation(output)
        : render(output);
    }
    if (REFUSALS[`${name} ${sub}`]) {
      if (rest.includes("--help"))
        return renderPresentation(
          `command: argo-workflows-axi ${name} ${sub}\ndescription: Refused operation\n`,
        );
      throw refused(`${name} ${sub}`);
    }
    throw axiError(`Unknown subcommand: ${name} ${sub}`, "VALIDATION_ERROR", [
      `Valid subcommands: ${Object.keys(noun.subcommands).join(", ")}`,
      `Run \`argo-workflows-axi ${name} --help\``,
    ]);
  };
}

function refusedCommand(key: string): AxiCliCommand<undefined> {
  return async (args) => {
    if (args.includes("--help"))
      return renderPresentation(
        `command: argo-workflows-axi ${key}\ndescription: Refused operation\n`,
      );
    throw refused(key);
  };
}

export function buildCommands(): Record<string, AxiCliCommand<undefined>> {
  const commands: Record<string, AxiCliCommand<undefined>> = {
    context: rendered(async (args) => {
      if (args.includes("--help"))
        return `command: argo-workflows-axi context\ndescription: Internal session context recorder\n`;
      if (args[0] === "end") {
        let payload: unknown;
        try {
          payload = JSON.parse(
            await new Promise<string>((resolve, reject) => {
              let body = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (chunk: string) => {
                body += chunk;
              });
              process.stdin.on("end", () => resolve(body));
              process.stdin.on("error", reject);
            }),
          );
        } catch {
          return { recorded: false };
        }
        recordSession(payload);
        return { recorded: true };
      }
      if (args.length === 0)
        return ctxView(
          parseArgs([], TARGET_FLAGS, "argo-workflows-axi context"),
        );
      throw axiError(
        "Use `argo-workflows-axi context end` from the SessionEnd hook",
        "VALIDATION_ERROR",
      );
    }),
    triage: rendered(triageCommand),
    ctx: rendered(ctxCommand),
    setup: rendered(setupCommand),
  };
  for (const [name, noun] of Object.entries(NOUNS)) {
    commands[name] = nounHandler(name, noun);
  }
  for (const key of Object.keys(REFUSALS)) {
    if (!key.includes(" ")) commands[key] = refusedCommand(key);
  }
  return commands;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    packageName: "argo-workflows-axi",
    argv,
    topLevelHelp: TOP_LEVEL_HELP,
    home: async () => render(await homeView()),
    formatError,
    commands: buildCommands(),
    renderUnknownCommand: (command) =>
      `${render({
        error: `Unknown command: ${command}`,
        code: "VALIDATION_ERROR",
        help: [
          "Valid commands: triage, wf, cron, template, clustertemplate, archive, ctx, setup, update",
          "Run `argo-workflows-axi --help`",
        ],
      })}\n`,
  });
}

/** Entry for the `argo-workflows-axi-ctx` hook binary: offline ctx, never fails the session. */
export async function mainCtx(): Promise<void> {
  try {
    const view = await ctxView(
      parseArgs([], TARGET_FLAGS, "argo-workflows-axi-ctx"),
    );
    process.stdout.write(
      `${render({ tool: "argo-workflows-axi (offline context)", ...view })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${render({ tool: "argo-workflows-axi (offline context)", ctx: `unavailable - ${message}` })}\n`,
    );
  }
}
