import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import {
  TARGET_FLAGS,
  ALL_NAMESPACES_FLAG,
  assertName,
  flagValue,
  flagValues,
  hasFlag,
  mergeSpecs,
  parseArgs,
  requirePositionals,
  type FlagSpec,
  type ParsedArgs,
} from "../args.js";
import {
  getClusterTemplate,
  getCronWorkflow,
  getTemplate,
  type CronWorkflow,
} from "../cron-data.js";
import { axiError, errorCode, errorMessage } from "../errors.js";
import { shellQuote } from "../format.js";
import { APPLY_FLAG, checkWrite, type GateDecision } from "../gate.js";
import { redactText, redactValue } from "../redact.js";
import type { WriteOperationId } from "../registry.js";
import { parseJsonStream, runWrite } from "../seam.js";
import {
  describeTarget,
  forwardTarget,
  resolveTarget,
  targetSuffix,
  type Target,
} from "../target.js";
import {
  COMPLETED_PHASES,
  FAILED_PHASES,
  fetchWorkflow,
  isSuspended,
  phaseOf,
  type Parameter,
  type Workflow,
} from "../workflow.js";
import { lintFiles } from "./wf-read.js";

/**
 * Gated writes (design W3 minus `wf delete`, S3, S8, S15, W5, W6).
 * Every write previews unless `--apply` is passed; see `src/gate.ts`.
 */

type Output = Record<string, unknown> | string;

export const MAX_NAMES = 20;

const WRITE_FLAGS: FlagSpec = mergeSpecs(TARGET_FLAGS, ALL_NAMESPACES_FLAG, {
  bool: [APPLY_FLAG],
});

const TARGET_HELP =
  "  -n, --namespace <ns> and --context <name> (or -s, --argo-server <host:port>): required with --apply";

interface Plan {
  /** Present when nothing would change: an idempotent no-op (S15). */
  noop?: string;
  /** Present when the write cannot be done for this object. */
  blocked?: string;
  /** What --apply would do. */
  change?: string;
  phase: string;
}

interface NamedWrite<T> {
  op: WriteOperationId;
  noun: "wf" | "cron";
  verb: string;
  done: string;
  help: string;
  flags: FlagSpec;
  fetch: (name: string, target: ReturnType<typeof forwardTarget>) => Promise<T>;
  plan: (obj: T, parsed: ParsedArgs) => Plan;
  /** Flags forwarded to argo, as `--flag=value` tokens. */
  argoArgs: (parsed: ParsedArgs) => string[];
  /** Same flags as typed by the user, for the `run:` command. */
  echoArgs: (parsed: ParsedArgs) => string[];
}

function parameterArgs(parsed: ParsedArgs): string[] {
  return flagValues(parsed, "--parameter").map((p) => {
    const eq = p.indexOf("=");
    if (eq <= 0) {
      throw axiError(
        `--parameter must be key=value (got ${JSON.stringify(p)})`,
        "VALIDATION_ERROR",
      );
    }
    return `--parameter=${p}`;
  });
}

function echoParameters(parsed: ParsedArgs): string[] {
  return flagValues(parsed, "--parameter").map((p) => `-p ${shellQuote(p)}`);
}

function wfPhasePlan(wf: Workflow): Plan | undefined {
  const phase = phaseOf(wf);
  return COMPLETED_PHASES.has(phase)
    ? { noop: "already_completed", phase }
    : undefined;
}

const fetchWf = (name: string, target: ReturnType<typeof forwardTarget>) =>
  fetchWorkflow(name, target);
const fetchCron = (name: string, target: ReturnType<typeof forwardTarget>) =>
  getCronWorkflow(name, target);

function nodeSelectorArgs(parsed: ParsedArgs): string[] {
  const selector = flagValue(parsed, "--node-field-selector");
  return selector ? [`--node-field-selector=${selector}`] : [];
}

function echoNodeSelector(parsed: ParsedArgs): string[] {
  const selector = flagValue(parsed, "--node-field-selector");
  return selector ? [`--node-field-selector ${shellQuote(selector)}`] : [];
}

function usageHelp(
  cmd: string,
  description: string,
  flags: string[],
  examples: string[],
): string {
  return `command: argo-workflows-axi ${cmd}
description: ${description}. Previews by default; nothing changes without --apply.
flags:
${[...flags, "  --apply: Run the write (target must be explicit and in the local allowlist)", TARGET_HELP].join("\n")}
examples[${examples.length}]:
${examples.map((e) => `  ${e}`).join("\n")}
`;
}

export const WRITES: Record<
  string,
  NamedWrite<Workflow> | NamedWrite<CronWorkflow>
> = {
  "wf suspend": {
    op: "wf.suspend",
    noun: "wf",
    verb: "suspend",
    done: "suspended",
    flags: WRITE_FLAGS,
    help: usageHelp(
      "wf suspend <name...>",
      "Suspend running workflows (reversible with `wf resume`)",
      [],
      [
        "argo-workflows-axi wf suspend nightly-etl-x7k2p",
        "argo-workflows-axi wf suspend nightly-etl-x7k2p --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchWf,
    plan: (wf) =>
      wfPhasePlan(wf) ??
      (isSuspended(wf)
        ? { noop: "already_suspended", phase: phaseOf(wf) }
        : { change: "suspend", phase: phaseOf(wf) }),
    argoArgs: () => [],
    echoArgs: () => [],
  } satisfies NamedWrite<Workflow>,
  "wf resume": {
    op: "wf.resume",
    noun: "wf",
    verb: "resume",
    done: "resumed",
    flags: mergeSpecs(WRITE_FLAGS, { value: ["--node-field-selector"] }),
    help: usageHelp(
      "wf resume <name...>",
      "Resume suspended workflows or suspend steps",
      [
        "  --node-field-selector <sel>: Resume only matching nodes, e.g. displayName=approve",
      ],
      [
        "argo-workflows-axi wf resume nightly-etl-x7k2p",
        "argo-workflows-axi wf resume release-x2 --node-field-selector displayName=approve",
      ],
    ),
    fetch: fetchWf,
    plan: (wf) =>
      wfPhasePlan(wf) ??
      (isSuspended(wf)
        ? { change: "resume", phase: phaseOf(wf) }
        : { noop: "not_suspended", phase: phaseOf(wf) }),
    argoArgs: nodeSelectorArgs,
    echoArgs: echoNodeSelector,
  } satisfies NamedWrite<Workflow>,
  "wf stop": {
    op: "wf.stop",
    noun: "wf",
    verb: "stop",
    done: "stop_requested",
    flags: mergeSpecs(WRITE_FLAGS, {
      value: ["--message", "--node-field-selector"],
    }),
    help: usageHelp(
      "wf stop <name...>",
      "Stop workflows; exit handlers still run (use `wf terminate` to skip them)",
      [
        "  --message <text>: Message recorded on the stopped nodes",
        "  --node-field-selector <sel>: Stop only matching nodes",
      ],
      [
        "argo-workflows-axi wf stop nightly-etl-x7k2p",
        "argo-workflows-axi wf stop nightly-etl-x7k2p --message 'bad input' --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchWf,
    plan: (wf) =>
      wfPhasePlan(wf) ??
      (wf.spec?.shutdown
        ? {
            noop: `already_shutting_down (${wf.spec.shutdown})`,
            phase: phaseOf(wf),
          }
        : { change: "stop (exit handlers run)", phase: phaseOf(wf) }),
    argoArgs: (parsed) => {
      const message = flagValue(parsed, "--message");
      return [
        ...(message ? [`--message=${message}`] : []),
        ...nodeSelectorArgs(parsed),
      ];
    },
    echoArgs: (parsed) => {
      const message = flagValue(parsed, "--message");
      return [
        ...(message ? [`--message ${shellQuote(message)}`] : []),
        ...echoNodeSelector(parsed),
      ];
    },
  } satisfies NamedWrite<Workflow>,
  "wf terminate": {
    op: "wf.terminate",
    noun: "wf",
    verb: "terminate",
    done: "terminate_requested",
    flags: WRITE_FLAGS,
    help: usageHelp(
      "wf terminate <name...>",
      "Terminate workflows immediately; exit handlers do not run",
      [],
      [
        "argo-workflows-axi wf terminate nightly-etl-x7k2p",
        "argo-workflows-axi wf terminate nightly-etl-x7k2p --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchWf,
    plan: (wf) =>
      wfPhasePlan(wf) ??
      (wf.spec?.shutdown === "Terminate"
        ? { noop: "already_terminating", phase: phaseOf(wf) }
        : { change: "terminate (no exit handlers)", phase: phaseOf(wf) }),
    argoArgs: () => [],
    echoArgs: () => [],
  } satisfies NamedWrite<Workflow>,
  "wf retry": {
    op: "wf.retry",
    noun: "wf",
    verb: "retry",
    done: "retried",
    flags: mergeSpecs(WRITE_FLAGS, {
      value: ["--node-field-selector"],
      repeatable: ["--parameter"],
      bool: ["--restart-successful"],
      aliases: { "-p": "--parameter" },
    }),
    help: usageHelp(
      "wf retry <name...>",
      "Re-run the failed steps of Failed or Error workflows, on the same workflow object",
      [
        "  --node-field-selector <sel>: Restrict which nodes are reset",
        "  --restart-successful: Also re-run succeeded nodes matching --node-field-selector",
        "  -p, --parameter <k=v>: Override a global parameter (repeatable)",
      ],
      [
        "argo-workflows-axi wf retry nightly-etl-x7k2p",
        "argo-workflows-axi wf retry nightly-etl-x7k2p --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchWf,
    plan: (wf, parsed) => {
      const phase = phaseOf(wf);
      if (!COMPLETED_PHASES.has(phase))
        return { noop: "already_running", phase };
      if (phase === "Succeeded") {
        const ok =
          hasFlag(parsed, "--restart-successful") &&
          flagValue(parsed, "--node-field-selector");
        return ok
          ? { change: "re-run matching succeeded nodes", phase }
          : { noop: "nothing_to_retry", phase };
      }
      return { change: "retry failed steps on the same workflow", phase };
    },
    argoArgs: (parsed) => [
      ...nodeSelectorArgs(parsed),
      ...(hasFlag(parsed, "--restart-successful")
        ? ["--restart-successful"]
        : []),
      ...parameterArgs(parsed),
    ],
    echoArgs: (parsed) => [
      ...echoNodeSelector(parsed),
      ...(hasFlag(parsed, "--restart-successful")
        ? ["--restart-successful"]
        : []),
      ...echoParameters(parsed),
    ],
  } satisfies NamedWrite<Workflow>,
  "wf resubmit": {
    op: "wf.resubmit",
    noun: "wf",
    verb: "resubmit",
    done: "resubmitted",
    flags: mergeSpecs(WRITE_FLAGS, {
      value: ["--priority"],
      repeatable: ["--parameter"],
      bool: ["--memoized"],
      aliases: { "-p": "--parameter" },
    }),
    help: usageHelp(
      "wf resubmit <name...>",
      "Create a new workflow from an existing one (not idempotent: each --apply creates another)",
      [
        "  --memoized: Re-use successful steps (needs a Failed or Error workflow)",
        "  -p, --parameter <k=v>: Override a global parameter (repeatable)",
        "  --priority <n>: Workflow priority",
      ],
      [
        "argo-workflows-axi wf resubmit nightly-etl-x7k2p",
        "argo-workflows-axi wf resubmit nightly-etl-x7k2p --memoized --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchWf,
    plan: (wf, parsed) => {
      const phase = phaseOf(wf);
      if (hasFlag(parsed, "--memoized") && !FAILED_PHASES.has(phase)) {
        return {
          blocked: `--memoized needs a Failed or Error workflow (this one is ${phase})`,
          phase,
        };
      }
      return { change: "create a new workflow from this one", phase };
    },
    argoArgs: (parsed) => {
      const priority = flagValue(parsed, "--priority");
      if (priority !== undefined && !/^-?\d+$/.test(priority)) {
        throw axiError("--priority must be a whole number", "VALIDATION_ERROR");
      }
      return [
        ...(hasFlag(parsed, "--memoized") ? ["--memoized"] : []),
        ...(priority !== undefined ? [`--priority=${priority}`] : []),
        ...parameterArgs(parsed),
      ];
    },
    echoArgs: (parsed) => {
      const priority = flagValue(parsed, "--priority");
      return [
        ...(hasFlag(parsed, "--memoized") ? ["--memoized"] : []),
        ...(priority !== undefined ? [`--priority ${priority}`] : []),
        ...echoParameters(parsed),
      ];
    },
  } satisfies NamedWrite<Workflow>,
  "cron suspend": {
    op: "cron.suspend",
    noun: "cron",
    verb: "suspend",
    done: "suspended",
    flags: WRITE_FLAGS,
    help: usageHelp(
      "cron suspend <name...>",
      "Suspend cron workflows so no new runs are scheduled",
      [],
      [
        "argo-workflows-axi cron suspend nightly-etl",
        "argo-workflows-axi cron suspend nightly-etl --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchCron,
    plan: (cron) =>
      cron.spec?.suspend
        ? { noop: "already_suspended", phase: "suspended" }
        : { change: "suspend schedule", phase: "active" },
    argoArgs: () => [],
    echoArgs: () => [],
  } satisfies NamedWrite<CronWorkflow>,
  "cron resume": {
    op: "cron.resume",
    noun: "cron",
    verb: "resume",
    done: "resumed",
    flags: WRITE_FLAGS,
    help: usageHelp(
      "cron resume <name...>",
      "Resume suspended cron workflows",
      [],
      [
        "argo-workflows-axi cron resume nightly-etl",
        "argo-workflows-axi cron resume nightly-etl --context kind-dev -n argo --apply",
      ],
    ),
    fetch: fetchCron,
    plan: (cron) =>
      cron.spec?.suspend
        ? { change: "resume schedule", phase: "suspended" }
        : { noop: "not_suspended", phase: "active" },
    argoArgs: () => [],
    echoArgs: () => [],
  } satisfies NamedWrite<CronWorkflow>,
};

interface Row {
  name: string;
  phase: string;
  plan: Plan;
}

function targetLine(target: Target): string {
  return describeTarget(target);
}

async function runNamedWrite<T>(
  spec: NamedWrite<T>,
  args: string[],
): Promise<Output> {
  if (args.includes("--help")) return spec.help;
  const usage = `argo-workflows-axi ${spec.noun} ${spec.verb} <name...>`;
  const parsed = parseArgs(args, spec.flags, usage);
  if (parsed.positionals.length > MAX_NAMES) {
    throw axiError(
      `At most ${MAX_NAMES} names per call (got ${parsed.positionals.length})`,
      "VALIDATION_ERROR",
      [
        "Split the names across several calls; selector-based bulk writes are not offered",
      ],
    );
  }
  const names = requirePositionals(parsed, 1, MAX_NAMES, usage);
  for (const name of names)
    assertName(name, spec.noun === "wf" ? "workflow" : "cron workflow", usage);
  if (new Set(names).size !== names.length) {
    throw axiError(
      "The same name was given more than once",
      "VALIDATION_ERROR",
    );
  }
  // Validates flag values (e.g. --parameter, --priority) before any call.
  const argoArgs = spec.argoArgs(parsed);

  const target = await resolveTarget(parsed);
  const command = [
    spec.noun,
    spec.verb,
    ...names,
    ...spec.echoArgs(parsed),
  ].join(" ");
  const gate = checkWrite(spec.op, parsed, target, command);
  const forward = forwardTarget(parsed);

  const rows: Row[] = [];
  for (const name of names) {
    try {
      const obj = await spec.fetch(name, forward);
      const plan = spec.plan(obj, parsed);
      rows.push({ name, phase: plan.phase, plan });
    } catch (error) {
      rows.push({
        name,
        phase: "",
        plan: {
          blocked: `${errorCode(error) ?? "UNKNOWN"}: ${errorMessage(error)}`,
          phase: "",
        },
      });
    }
  }

  if (!gate.apply) return previewOutput(spec, gate, target, rows);
  return applyOutput(spec, gate, target, rows, argoArgs, forward, parsed);
}

function previewOutput<T>(
  spec: NamedWrite<T>,
  gate: GateDecision,
  target: Target,
  rows: Row[],
): Output {
  const actionable = rows.filter((r) => r.plan.change);
  const out: Record<string, unknown> = {
    dry_run: true,
    action: `${spec.noun} ${spec.verb}`,
    target: targetLine(target),
    writable: gate.writable,
    [spec.noun === "wf" ? "workflows" : "cron_workflows"]: rows.map((r) => ({
      name: r.name,
      phase: r.phase,
      change:
        r.plan.change ??
        (r.plan.noop
          ? `no-op (${r.plan.noop})`
          : `blocked - ${r.plan.blocked}`),
    })),
  };
  if (actionable.length === 0) {
    out.result = "nothing to do";
    return out;
  }
  out.run = gate.run;
  if (!gate.writable.startsWith("yes")) {
    out.help = [
      "`run` will be refused until a human adds this target to the local allowlist (see `writable`)",
    ];
  }
  return out;
}

async function applyOutput<T>(
  spec: NamedWrite<T>,
  gate: GateDecision,
  target: Target,
  rows: Row[],
  argoArgs: string[],
  forward: ReturnType<typeof forwardTarget>,
  parsed: ParsedArgs,
): Promise<Output> {
  const results: Array<Record<string, string>> = [];
  let failures = 0;
  for (const row of rows) {
    if (row.plan.noop) {
      results.push({ name: row.name, result: row.plan.noop, phase: row.phase });
      continue;
    }
    if (row.plan.blocked) {
      failures += 1;
      results.push({
        name: row.name,
        result: `failed - ${row.plan.blocked}`,
        phase: row.phase,
      });
      continue;
    }
    try {
      await runWrite(spec.op, [row.name, ...argoArgs], gate.approval!, {
        target: forward,
      });
      let phase = row.phase;
      if (spec.noun === "wf") {
        try {
          phase = phaseOf(await fetchWorkflow(row.name, forward));
        } catch {
          // The write succeeded; the follow-up read is best effort.
        }
      }
      results.push({ name: row.name, result: spec.done, phase });
    } catch (error) {
      failures += 1;
      results.push({
        name: row.name,
        result: `failed - ${errorCode(error) ?? "UNKNOWN"}: ${errorMessage(error)}`,
        phase: row.phase,
      });
    }
  }

  const suffix = targetSuffix(parsed);
  const out: Record<string, unknown> = {};
  if (failures > 0) {
    out.error = `${failures} of ${rows.length} ${spec.verb} operations failed`;
    out.code = "WRITE_FAILED";
    process.exitCode = 1;
  }
  out.action = `${spec.noun} ${spec.verb}`;
  out.target = targetLine(target);
  out.results = results;
  out.help =
    spec.noun === "wf"
      ? [`Run \`argo-workflows-axi wf get <name>${suffix}\` to check progress`]
      : [
          `Run \`argo-workflows-axi cron get <name>${suffix}\` to check the schedule`,
        ];
  return out;
}

export function namedWrite(key: string): (args: string[]) => Promise<Output> {
  const spec = WRITES[key] as NamedWrite<unknown>;
  return (args) => runNamedWrite(spec, args);
}

// ---------------------------------------------------------------- wf submit

export const WF_SUBMIT_HELP = usageHelp(
  "wf submit <file|-> | --from <kind>/<name>",
  "Submit a workflow from a manifest file (or `-` for stdin) or from an existing template or cron workflow",
  [
    "  --from <kind>/<name>: workflowtemplate/<n>, clusterworkflowtemplate/<n> or cronwf/<n> (argo's other spellings, e.g. wftmpl/, cwftmpl/, cronworkflow/, also accepted)",
    "  -p, --parameter <k=v>: Input parameter (repeatable)",
    "  --name <name>: Workflow name; makes retries safe (an existing name is a no-op)",
    "  --generate-name <prefix>: Name prefix",
    "  --entrypoint <template>: Override the entrypoint",
    "  --serviceaccount <name>: Run pods as this service account",
    "  -l, --labels <k=v,...>: Labels for the workflow",
    "  --priority <n>: Workflow priority",
  ],
  [
    "argo-workflows-axi wf submit --from workflowtemplate/nightly-etl -p date=2026-10-28 --name nightly-etl-20261028",
    "argo-workflows-axi wf submit my-wf.yaml",
    "argo-workflows-axi wf submit --from cronwf/nightly-etl --context kind-dev -n argo --apply",
  ],
);

const SUBMIT_SPEC = mergeSpecs(WRITE_FLAGS, {
  value: [
    "--from",
    "--name",
    "--generate-name",
    "--entrypoint",
    "--serviceaccount",
    "--labels",
    "--priority",
  ],
  repeatable: ["--parameter"],
  aliases: { "-p": "--parameter", "-l": "--labels" },
});

const FROM_KINDS: Record<
  string,
  "workflowtemplate" | "clusterworkflowtemplate" | "cronwf"
> = {
  WorkflowTemplate: "workflowtemplate",
  workflowtemplate: "workflowtemplate",
  workflowtemplates: "workflowtemplate",
  wftmpl: "workflowtemplate",
  ClusterWorkflowTemplate: "clusterworkflowtemplate",
  clusterworkflowtemplate: "clusterworkflowtemplate",
  clusterworkflowtemplates: "clusterworkflowtemplate",
  cwftmpl: "clusterworkflowtemplate",
  CronWorkflow: "cronwf",
  cronworkflow: "cronwf",
  cronworkflows: "cronwf",
  cronwf: "cronwf",
};

function parseFrom(
  value: string,
  usage: string,
): { kind: string; name: string } {
  const slash = value.indexOf("/");
  const given = value.slice(0, slash);
  const kind = Object.hasOwn(FROM_KINDS, given) ? FROM_KINDS[given] : undefined;
  const name = value.slice(slash + 1);
  if (slash <= 0 || !kind) {
    throw axiError(
      `--from must be <kind>/<name> (got ${JSON.stringify(value)})`,
      "VALIDATION_ERROR",
      ["Kinds: workflowtemplate, clusterworkflowtemplate, cronwf"],
    );
  }
  assertName(name, kind, usage);
  return { kind, name };
}

interface SubmitSource {
  description: string;
  entrypoint?: string;
  declared: Parameter[];
  name?: string;
  generateName?: string;
  lint?: string[];
}

function mergeParameters(
  declared: Parameter[],
  overrides: string[],
): { rows: Array<Record<string, string>>; unknown: string[] } {
  const given = new Map<string, string>();
  for (const p of overrides) {
    const eq = p.indexOf("=");
    given.set(p.slice(0, eq), p.slice(eq + 1));
  }
  const rows = declared.map((p) => {
    const override = given.get(p.name);
    const base = p.value ?? p.default;
    return {
      name: p.name,
      value: override ?? base ?? "",
      source:
        override !== undefined
          ? "given"
          : base !== undefined
            ? "default"
            : "missing (required)",
    };
  });
  const unknown = [...given.keys()].filter(
    (k) => !declared.some((p) => p.name === k),
  );
  for (const name of unknown) {
    rows.push({
      name,
      value: given.get(name) ?? "",
      source: "given (not declared)",
    });
  }
  return { rows, unknown };
}

async function submitSourceFromResource(
  kind: string,
  name: string,
  forward: ReturnType<typeof forwardTarget>,
): Promise<SubmitSource> {
  if (kind === "cronwf") {
    const cron = await getCronWorkflow(name, forward);
    return {
      description: `cronwf/${name}`,
      entrypoint: cron.spec?.workflowSpec?.entrypoint,
      declared: cron.spec?.workflowSpec?.arguments?.parameters ?? [],
    };
  }
  const tmpl =
    kind === "clusterworkflowtemplate"
      ? await getClusterTemplate(name, forward)
      : await getTemplate(name, forward);
  return {
    description: `${kind}/${name}`,
    entrypoint: tmpl.spec?.entrypoint,
    declared: tmpl.spec?.arguments?.parameters ?? [],
  };
}

type WorkflowManifest = Workflow & {
  kind?: string;
  metadata?: { generateName?: string; namespace?: string };
};

interface Manifest {
  /** Private temp file holding exactly the checked manifest, as JSON. */
  path: string;
  wf: WorkflowManifest;
}

function readManifest(file: string, namespace: string): WorkflowManifest {
  const docs = parseAllDocuments(
    readFileSync(file === "-" ? 0 : file, "utf-8"),
    { version: "1.1" },
  );
  const problems = docs.flatMap((d) => [...d.errors, ...d.warnings]);
  if (problems.length > 0) {
    throw axiError(
      `The manifest is not valid YAML: ${problems[0].message.split("\n")[0]}`,
      "VALIDATION_ERROR",
      ["Fix the manifest, then preview again"],
    );
  }
  const manifests = docs
    .map((d) => d.toJSON() as Record<string, unknown> | null)
    .filter(Boolean) as Array<Record<string, unknown>>;
  if (manifests.length !== 1) {
    throw axiError(
      `Expected exactly one manifest in the file, found ${manifests.length}`,
      "VALIDATION_ERROR",
      ["Split the file and submit one workflow per call"],
    );
  }
  const wf = manifests[0] as unknown as WorkflowManifest;
  if (wf.kind !== "Workflow") {
    throw axiError(
      `Expected kind Workflow, found ${String(wf.kind)}`,
      "VALIDATION_ERROR",
      [
        "To run a WorkflowTemplate or CronWorkflow, use `wf submit --from workflowtemplate/<name>` or `--from cronwf/<name>`",
      ],
    );
  }
  const manifestNamespace = wf.metadata?.namespace;
  if (manifestNamespace && manifestNamespace !== namespace) {
    throw axiError(
      `The manifest sets metadata.namespace ${manifestNamespace}, but the target namespace is ${namespace}`,
      "VALIDATION_ERROR",
      [
        `Pass \`-n ${manifestNamespace}\`, or remove metadata.namespace from the manifest`,
      ],
    );
  }
  return wf;
}

/** Submit only what was checked: the normalized manifest, written to a private temp file. */
async function withManifest<T>(
  file: string,
  namespace: string,
  fn: (manifest: Manifest) => Promise<T>,
): Promise<T> {
  const wf = readManifest(file, namespace);
  const dir = mkdtempSync(join(tmpdir(), "argo-workflows-axi-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(wf), { mode: 0o600 });
  try {
    return await fn({ path, wf });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function submitSourceFromFile(
  { path, wf }: Manifest,
  forward: ReturnType<typeof forwardTarget>,
): Promise<SubmitSource> {
  const lint = await lintFiles("wf.lint", [path], forward);
  return {
    description: "manifest",
    entrypoint: wf.spec?.entrypoint,
    declared: wf.spec?.arguments?.parameters ?? [],
    name: wf.metadata?.name,
    generateName: wf.metadata?.generateName,
    lint: lint.ok
      ? []
      : lint.problems.length > 0
        ? lint.problems
        : ["lint failed"],
  };
}

export async function wfSubmit(args: string[]): Promise<Output> {
  if (args.includes("--help")) return WF_SUBMIT_HELP;
  const usage = "argo-workflows-axi wf submit <file|-> | --from <kind>/<name>";
  const parsed = parseArgs(args, SUBMIT_SPEC, usage);
  const files = requirePositionals(parsed, 0, 1, usage);
  const fromRaw = flagValue(parsed, "--from");
  if ((files.length === 0) === (fromRaw === undefined)) {
    throw axiError(
      "Pass exactly one of a manifest file (or `-`) or --from <kind>/<name>",
      "VALIDATION_ERROR",
      [`Run \`${usage}\``],
    );
  }
  const from = fromRaw ? parseFrom(fromRaw, usage) : undefined;
  const params = parameterArgs(parsed);
  const name = flagValue(parsed, "--name");
  if (name) assertName(name, "workflow", usage);
  const generateName = flagValue(parsed, "--generate-name");
  if (generateName && !/^[a-z0-9]([-a-z0-9.]*)?$/.test(generateName)) {
    throw axiError(
      "--generate-name must be a lowercase name prefix",
      "VALIDATION_ERROR",
    );
  }
  const priority = flagValue(parsed, "--priority");
  if (priority !== undefined && !/^-?\d+$/.test(priority)) {
    throw axiError("--priority must be a whole number", "VALIDATION_ERROR");
  }
  const target = await resolveTarget(parsed);
  const forward = forwardTarget(parsed);
  const echo: string[] = ["wf", "submit"];
  if (from) echo.push(`--from ${from.kind}/${from.name}`);
  else echo.push(shellQuote(files[0]));
  echo.push(...echoParameters(parsed));
  const passthrough: Array<[string, string | undefined]> = [
    ["--name", name],
    ["--generate-name", generateName],
    ["--entrypoint", flagValue(parsed, "--entrypoint")],
    ["--serviceaccount", flagValue(parsed, "--serviceaccount")],
    ["--labels", flagValue(parsed, "--labels")],
    ["--priority", priority],
  ];
  for (const [flag, value] of passthrough) {
    if (value !== undefined) echo.push(`${flag} ${shellQuote(value)}`);
  }
  const gate = checkWrite("wf.submit", parsed, target, echo.join(" "));

  const submit = async (
    source: SubmitSource,
    argoSource: string,
  ): Promise<Output> => {
    const merged = mergeParameters(
      source.declared,
      flagValues(parsed, "--parameter"),
    );
    const finalName = name ?? source.name;

    let existing: Workflow | undefined;
    if (finalName) {
      try {
        existing = await fetchWorkflow(finalName, forward);
      } catch (error) {
        if (errorCode(error) !== "NOT_FOUND") throw error;
      }
    }

    const missing = merged.rows
      .filter((r) => r.source.startsWith("missing"))
      .map((r) => r.name);
    const blockers: string[] = [];
    if (missing.length > 0)
      blockers.push(`missing required parameters: ${missing.join(", ")}`);
    if (source.lint && source.lint.length > 0)
      blockers.push(...source.lint.map((l) => `lint: ${l}`));
    const warnings: string[] = [];
    if (existing)
      warnings.push(
        `workflow ${finalName} already exists (${phaseOf(existing)}); submit is a no-op`,
      );
    if (merged.unknown.length > 0)
      warnings.push(
        `parameters not declared by the source: ${merged.unknown.join(", ")}`,
      );
    if (!finalName)
      warnings.push(
        "not idempotent: each --apply creates a new workflow; pass --name to make retries safe",
      );

    const workflowName =
      finalName ??
      `${generateName ?? source.generateName ?? `${from?.name ?? "workflow"}-`}<random>`;

    if (!gate.apply) {
      const out: Record<string, unknown> = {
        dry_run: true,
        action: "wf submit",
        target: describeTarget(target),
        writable: gate.writable,
        source: source.description,
        workflow: workflowName,
      };
      if (flagValue(parsed, "--entrypoint") ?? source.entrypoint) {
        out.entrypoint = flagValue(parsed, "--entrypoint") ?? source.entrypoint;
      }
      if (merged.rows.length > 0) out.parameters = merged.rows;
      if (warnings.length > 0) out.warnings = warnings.join("; ");
      if (existing) {
        out.result = "nothing to do";
      } else if (blockers.length > 0) {
        out.blocked = blockers.join("; ");
        out.help = [
          missing.length > 0
            ? "Add `-p <name>=<value>` for each missing parameter, then preview again"
            : "Fix the manifest (see `blocked`), then preview again",
        ];
      } else {
        out.run = gate.run;
        if (!gate.writable.startsWith("yes")) {
          out.help = [
            "`run` will be refused until a human adds this target to the local allowlist (see `writable`)",
          ];
        }
      }
      const redacted = redactValue(out);
      if (redacted.count > 0)
        redacted.value.redacted = `${redacted.count} sensitive values hidden`;
      return redacted.value;
    }

    const suffix = targetSuffix(parsed);
    if (existing) {
      return {
        action: "wf submit",
        target: describeTarget(target),
        result: "already_exists",
        workflow: { name: finalName, phase: phaseOf(existing) },
        help: [
          `Run \`argo-workflows-axi wf get ${finalName}${suffix}\` for its state`,
        ],
      };
    }
    if (blockers.length > 0) {
      throw axiError(
        `Submit blocked: ${redactText(blockers.join("; ")).text}`,
        "INVALID_REQUEST",
        ["Fix the parameters or manifest, then preview again without --apply"],
      );
    }

    const argoArgs = [
      argoSource,
      ...params,
      ...passthrough
        .filter(([, v]) => v !== undefined)
        .map(([flag, v]) => `${flag}=${v}`),
      "--output=json",
    ];
    let created: Workflow | undefined;
    try {
      const { stdout } = await runWrite("wf.submit", argoArgs, gate.approval!, {
        target: forward,
      });
      created = parseJsonStream(stdout)[0] as Workflow | undefined;
    } catch (error) {
      if (errorCode(error) === "ALREADY_EXISTS" && finalName) {
        return {
          action: "wf submit",
          target: describeTarget(target),
          result: "already_exists",
          workflow: { name: finalName },
          help: [
            `Run \`argo-workflows-axi wf get ${finalName}${suffix}\` for its state`,
          ],
        };
      }
      throw error;
    }
    const createdName = created?.metadata?.name ?? finalName ?? "(unknown)";
    return {
      action: "wf submit",
      target: describeTarget(target),
      result: "submitted",
      workflow: {
        name: createdName,
        phase: created ? phaseOf(created) : "Pending",
      },
      help: [
        `Run \`argo-workflows-axi wf wait ${createdName}${suffix}\` to wait (bounded) for it to finish`,
        `Run \`argo-workflows-axi wf get ${createdName}${suffix}\` for its progress`,
      ],
    };
  };

  if (from) {
    return submit(
      await submitSourceFromResource(from.kind, from.name, forward),
      `--from=${from.kind}/${from.name}`,
    );
  }
  return withManifest(files[0], target.namespace, async (manifest) =>
    submit(await submitSourceFromFile(manifest, forward), manifest.path),
  );
}
