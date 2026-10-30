import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_NAMESPACES_FLAG,
  TARGET_FLAGS,
  assertName,
  flagValue,
  hasFlag,
  mergeSpecs,
  parseArgs,
  parseDuration,
  parsePositiveInt,
  requirePositionals,
} from "../args.js";
import { axiError, mapArgoFailure } from "../errors.js";
import {
  age,
  duration,
  pluralize,
  stripAnsi,
  truncateHead,
} from "../format.js";
import { redactText, redactValue } from "../redact.js";
import { runRead } from "../seam.js";
import {
  describeTarget,
  forwardTarget,
  resolveTarget,
  targetSuffix,
} from "../target.js";
import {
  COMPLETED_PHASES,
  exitCodeOf,
  failedLeafNodes,
  failureHint,
  fetchWorkflow,
  fetchWorkflows,
  nodeLabel,
  nodeTemplate,
  nodesOf,
  phaseOf,
  phaseTally,
  podNameOf,
  sortWorkflows,
  type WfNode,
  type Workflow,
} from "../workflow.js";

type Output = Record<string, unknown> | string;

const MESSAGE_LIMIT = 500;
const LOG_CHAR_CAP = 20_000;

// ---------------------------------------------------------------- wf list

const PHASES = ["Pending", "Running", "Succeeded", "Failed", "Error"];
const LIST_FIELDS = [
  "namespace",
  "started",
  "finished",
  "duration",
  "progress",
  "template",
  "cron",
  "uid",
];

export const WF_LIST_HELP = `command: argo-workflows-axi wf list
description: List workflows, failing and running first, with a count and a per-phase tally
flags:
  --status <phases>: Comma-separated phases (${PHASES.join(", ")})
  --since <dur>: Created within this duration (90s, 10m, 2h, 1d)
  --older <dur>: Finished before this duration
  -l, --selector <sel>: Label selector, e.g. app=etl
  --prefix <text>: Name prefix
  --limit <n>: Rows to show (default 50, max 1000)
  --fields <list>: Extra columns (${LIST_FIELDS.join(", ")})
  -n, --namespace <ns> | -A, --all-namespaces | --context <name> | -s, --argo-server <host:port>
examples[3]:
  argo-workflows-axi wf list
  argo-workflows-axi wf list --status Failed,Error --since 1d
  argo-workflows-axi wf list -A --prefix nightly- --fields duration,template
`;

const LIST_SPEC = mergeSpecs(TARGET_FLAGS, ALL_NAMESPACES_FLAG, {
  value: [
    "--status",
    "--since",
    "--older",
    "--selector",
    "--prefix",
    "--limit",
    "--fields",
  ],
  aliases: { "-l": "--selector" },
});

function normalizeStatuses(raw: string): string {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const match = PHASES.find((p) => p.toLowerCase() === s.toLowerCase());
      if (!match) {
        throw axiError(
          `Unknown phase ${JSON.stringify(s)} for --status`,
          "VALIDATION_ERROR",
          [`Valid phases: ${PHASES.join(", ")}`],
        );
      }
      return match;
    })
    .join(",");
}

function parseFields(raw: string | undefined): string[] {
  if (!raw) return [];
  const fields = raw
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const field of fields) {
    if (!LIST_FIELDS.includes(field)) {
      throw axiError(
        `Unknown field ${JSON.stringify(field)} for --fields`,
        "VALIDATION_ERROR",
        [`Valid fields: ${LIST_FIELDS.join(", ")}`],
      );
    }
  }
  return fields;
}

function listRow(
  wf: Workflow,
  fields: string[],
  withNamespace: boolean,
  withMessage: boolean,
) {
  const row: Record<string, string> = {};
  if (withNamespace || fields.includes("namespace"))
    row.namespace = wf.metadata.namespace ?? "";
  row.name = wf.metadata.name;
  row.phase = phaseOf(wf);
  row.age = age(wf.metadata.creationTimestamp);
  if (withMessage)
    row.message = truncateHead(wf.status?.message ?? "", 120).text;
  for (const field of fields) {
    switch (field) {
      case "started":
        row.started = age(wf.status?.startedAt);
        break;
      case "finished":
        row.finished = age(wf.status?.finishedAt);
        break;
      case "duration":
        row.duration = duration(wf.status?.startedAt, wf.status?.finishedAt);
        break;
      case "progress":
        row.progress = wf.status?.progress ?? "";
        break;
      case "template":
        row.template = wf.spec?.workflowTemplateRef?.name ?? "";
        break;
      case "cron":
        row.cron =
          wf.metadata.labels?.["workflows.argoproj.io/cron-workflow"] ?? "";
        break;
      case "uid":
        row.uid = wf.metadata.uid ?? "";
        break;
    }
  }
  return row;
}

export async function wfList(args: string[]): Promise<Output> {
  if (args.includes("--help")) return WF_LIST_HELP;
  const usage = "argo-workflows-axi wf list";
  const parsed = parseArgs(args, LIST_SPEC, usage);
  requirePositionals(parsed, 0, 0, usage);
  const limit = parsePositiveInt(
    flagValue(parsed, "--limit") ?? "50",
    "--limit",
    1000,
  );
  const fields = parseFields(flagValue(parsed, "--fields"));

  const argoArgs: string[] = [];
  const status = flagValue(parsed, "--status");
  if (status) argoArgs.push(`--status=${normalizeStatuses(status)}`);
  for (const flag of ["--since", "--older"]) {
    const value = flagValue(parsed, flag);
    if (value) {
      parseDuration(value, flag);
      argoArgs.push(`${flag}=${value}`);
    }
  }
  const selector = flagValue(parsed, "--selector");
  if (selector) argoArgs.push(`--selector=${selector}`);
  const prefix = flagValue(parsed, "--prefix");
  if (prefix) argoArgs.push(`--prefix=${prefix}`);
  const all = hasFlag(parsed, "--all-namespaces");
  if (all) argoArgs.push("--all-namespaces");

  const target = await resolveTarget(parsed);
  const workflows = sortWorkflows(
    await fetchWorkflows(argoArgs, forwardTarget(parsed)),
  );
  const suffix = targetSuffix(parsed);
  const scope = all
    ? "across all namespaces"
    : `in namespace ${target.namespace}`;

  if (workflows.length === 0) {
    const filtered = argoArgs.some((a) => !a.startsWith("--all-namespaces"));
    return {
      workflows: `0 workflows${filtered ? " matching these filters" : ""} ${scope}`,
      help: [
        `Run \`argo-workflows-axi template list${suffix}\` to see templates you can submit from`,
      ],
    };
  }

  const shown = workflows.slice(0, limit);
  const withMessage = shown.some((wf) => (wf.status?.message ?? "") !== "");
  const redacted = redactValue(
    shown.map((wf) => listRow(wf, fields, all, withMessage)),
  );
  const out: Record<string, unknown> = {
    count: `${shown.length} of ${workflows.length} total ${scope}`,
    phases: phaseTally(workflows),
    workflows: redacted.value,
  };
  if (redacted.count > 0)
    out.redacted = `${redacted.count} sensitive values hidden`;
  const help = [
    `Run \`argo-workflows-axi wf get <name>${suffix}\` for phase, parameters and failed steps`,
  ];
  if (workflows.length > shown.length) {
    help.push(
      `Run \`argo-workflows-axi wf list --limit ${Math.min(workflows.length, 1000)}${suffix}\` to see all ${workflows.length}`,
    );
  }
  if (workflows.some((wf) => ["Failed", "Error"].includes(phaseOf(wf)))) {
    help.push(
      `Run \`argo-workflows-axi triage${suffix}\` for failing steps and log tails`,
    );
  }
  out.help = help;
  return out;
}

// ---------------------------------------------------------------- wf get

export const WF_GET_HELP = `command: argo-workflows-axi wf get <name|@latest>
description: Workflow summary - phase, message, progress, duration, parameters - plus only the failed steps
flags:
  --nodes: Show every node, not just failed ones
  --tree: Show the node tree
  --full: Untruncated messages, ISO timestamps, labels and annotations
  -n, --namespace <ns> | --context <name> | -s, --argo-server <host:port>
examples[3]:
  argo-workflows-axi wf get nightly-etl-x7k2p
  argo-workflows-axi wf get @latest
  argo-workflows-axi wf get nightly-etl-x7k2p --tree
`;

const GET_SPEC = mergeSpecs(TARGET_FLAGS, {
  bool: ["--nodes", "--tree", "--full"],
});

export function failedNodeRows(wf: Workflow, full: boolean) {
  return failedLeafNodes(wf).map((node) => ({
    name: nodeLabel(node),
    template: nodeTemplate(node),
    phase: node.phase ?? "",
    exit_code: exitCodeOf(node) ?? "",
    message: full
      ? (node.message ?? "")
      : truncateHead(node.message ?? "", 200).text,
    hint: failureHint(node) ?? "",
    pod: node.type === "Pod" ? podNameOf(wf, node) : "",
  }));
}

/** Summary block shared by `wf get`, `wf wait` and write results. */
export function workflowSummary(
  wf: Workflow,
  full = false,
): Record<string, unknown> {
  const status = wf.status ?? {};
  const message = status.message ?? "";
  const summary: Record<string, unknown> = {
    name: wf.metadata.name,
    namespace: wf.metadata.namespace ?? "",
    phase: phaseOf(wf),
  };
  if (message)
    summary.message = full
      ? message
      : truncateHead(message, MESSAGE_LIMIT).text;
  if (status.progress) summary.progress = status.progress;
  if (full) {
    summary.created_at = wf.metadata.creationTimestamp ?? "";
    summary.started_at = status.startedAt ?? "";
    summary.finished_at = status.finishedAt ?? "";
  } else {
    summary.started = status.startedAt
      ? `${age(status.startedAt)} ago`
      : "not started";
  }
  summary.duration = duration(status.startedAt, status.finishedAt);
  if (wf.spec?.suspend) summary.suspended = "yes";
  if (wf.spec?.entrypoint) summary.entrypoint = wf.spec.entrypoint;
  if (wf.spec?.workflowTemplateRef?.name) {
    summary.template = `${wf.spec.workflowTemplateRef.clusterScope ? "clusterworkflowtemplate" : "workflowtemplate"}/${wf.spec.workflowTemplateRef.name}`;
  }
  const cron = wf.metadata.labels?.["workflows.argoproj.io/cron-workflow"];
  if (cron) summary.cron = cron;
  const params = wf.spec?.arguments?.parameters ?? [];
  if (params.length > 0) {
    summary.parameters = params.map((p) => ({
      name: p.name,
      value: full ? (p.value ?? "") : truncateHead(p.value ?? "", 200).text,
    }));
  }
  if (full) {
    if (wf.spec?.serviceAccountName)
      summary.service_account = wf.spec.serviceAccountName;
    if (wf.metadata.labels) summary.labels = wf.metadata.labels;
    if (wf.metadata.annotations) summary.annotations = wf.metadata.annotations;
  }
  return summary;
}

function treeLines(wf: Workflow, full: boolean): string[] {
  const nodes = wf.status?.nodes ?? {};
  const root =
    nodes[wf.metadata.name] ??
    nodesOf(wf).find((n) => !n.boundaryID && n.type !== "Pod");
  if (!root) return [];
  const lines: string[] = [];
  const visit = (node: WfNode, depth: number, seen: Set<string>) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const bits = [
      `${"  ".repeat(depth)}${nodeLabel(node)}`,
      node.type,
      node.phase ?? "",
    ];
    const d = duration(node.startedAt, node.finishedAt);
    if (d) bits.push(d);
    if (node.message && ["Failed", "Error"].includes(node.phase ?? "")) {
      bits.push(
        full
          ? `${node.message} (${node.message.length} chars)`
          : truncateHead(node.message, 80).text,
      );
    }
    lines.push(bits.join(" | "));
    for (const childId of node.children ?? []) {
      const child = nodes[childId];
      if (child) visit(child, depth + 1, seen);
    }
  };
  visit(root, 0, new Set());
  return lines;
}

export async function wfGet(args: string[]): Promise<Output> {
  if (args.includes("--help")) return WF_GET_HELP;
  const usage = "argo-workflows-axi wf get <name|@latest>";
  const parsed = parseArgs(args, GET_SPEC, usage);
  const [name] = requirePositionals(parsed, 1, 1, usage);
  if (name !== "@latest") assertName(name, "workflow", usage);
  const full = hasFlag(parsed, "--full");

  const wf = await fetchWorkflow(name, forwardTarget(parsed));
  const all = nodesOf(wf);
  const failedRows = failedNodeRows(wf, full);
  const out: Record<string, unknown> = { workflow: workflowSummary(wf, full) };

  if (hasFlag(parsed, "--tree")) {
    out.tree = treeLines(wf, full);
    if (
      !full &&
      all.some(
        (node) =>
          node.message &&
          ["Failed", "Error"].includes(node.phase ?? "") &&
          node.message.length > 80,
      )
    )
      out.help = [
        `Run \`argo-workflows-axi wf get ${wf.metadata.name} --tree --full${targetSuffix(parsed)}\` for untruncated tree messages`,
      ];
  } else if (hasFlag(parsed, "--nodes")) {
    out.nodes = `${all.length} of ${all.length} nodes shown`;
    out.all_nodes = all
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
      .map((n) => ({
        name: nodeLabel(n),
        type: n.type,
        phase: n.phase ?? "",
        template: nodeTemplate(n),
        duration: duration(n.startedAt, n.finishedAt),
      }));
  } else {
    out.nodes =
      failedRows.length > 0
        ? `${failedRows.length} of ${all.length} nodes shown (failed and errored only)`
        : `0 failed of ${all.length} nodes`;
    if (failedRows.length > 0) out.failed_nodes = failedRows;
  }

  const redacted = redactValue(out);
  const result = redacted.value;
  if (redacted.count > 0)
    result.redacted = `${redacted.count} sensitive values hidden`;

  const suffix = targetSuffix(parsed);
  const wfName = wf.metadata.name;
  const help: string[] = Array.isArray(result.help)
    ? result.help.map(String)
    : [];
  if (failedRows.length > 0) {
    help.push(
      `Run \`argo-workflows-axi wf logs ${wfName}${suffix}\` for the failing step's logs`,
    );
    help.push(
      `Run \`argo-workflows-axi wf retry ${wfName}${suffix}\` to preview retrying the failed steps`,
    );
  } else if (!COMPLETED_PHASES.has(phaseOf(wf))) {
    help.push(
      `Run \`argo-workflows-axi wf wait ${wfName}${suffix}\` to wait (bounded) for it to finish`,
    );
  }
  const truncated = JSON.stringify(result).includes("(truncated,");
  if (truncated && !full)
    help.push(
      `Run \`argo-workflows-axi wf get ${wfName} --full${suffix}\` for untruncated messages`,
    );
  if (help.length > 0) result.help = help;
  return result;
}

// ---------------------------------------------------------------- wf logs

export const WF_LOGS_HELP = `command: argo-workflows-axi wf logs <name|@latest> [<pod>]
description: Bounded logs. Without <pod>, picks the failed step's pod; never follows or streams.
flags:
  --tail <n>: Last lines per pod (default 100, max 5000)
  --full: Include up to 1,000,000 log characters (default cap 20,000)
  --grep <regex>: Only lines matching
  --since <dur>: Only lines newer than this duration (90s, 10m, 2h)
  --previous: Logs of the previous container instance (after a restart)
  -c, --container <name>: Container (default main)
  -n, --namespace <ns> | --context <name> | -s, --argo-server <host:port>
examples[3]:
  argo-workflows-axi wf logs nightly-etl-x7k2p
  argo-workflows-axi wf logs @latest --grep ERROR
  argo-workflows-axi wf logs nightly-etl-x7k2p nightly-etl-x7k2p-load-123456 --tail 300
`;

const LOGS_SPEC = mergeSpecs(TARGET_FLAGS, {
  value: ["--tail", "--grep", "--since", "--container"],
  bool: ["--previous", "--full"],
  aliases: { "-c": "--container" },
});

export interface LogTail {
  lines: string[];
  text: string;
  totalChars: number;
  truncated: boolean;
  redactions: number;
}

/** Clean, redact and cap log output, keeping the tail (S11). */
export function shapeLog(
  raw: string,
  singlePod?: string,
  cap = LOG_CHAR_CAP,
): LogTail {
  let lines = stripAnsi(raw).split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (singlePod) {
    const prefix = `${singlePod}: `;
    lines = lines.map((line) =>
      line.startsWith(prefix) ? line.slice(prefix.length) : line,
    );
  }
  let redactions = 0;
  lines = lines.map((line) => {
    const r = redactText(line);
    redactions += r.count;
    return r.text;
  });
  const full = lines.join("\n");
  if (full.length <= cap) {
    return {
      lines,
      text: full,
      totalChars: full.length,
      truncated: false,
      redactions,
    };
  }
  let kept = full.slice(full.length - cap);
  const firstBreak = kept.indexOf("\n");
  if (firstBreak !== -1) kept = kept.slice(firstBreak + 1);
  const keptLines = kept.split("\n");
  return {
    lines: keptLines,
    text: kept,
    totalChars: full.length,
    truncated: true,
    redactions,
  };
}

export async function fetchPodLog(
  wfName: string,
  pod: string | undefined,
  options: {
    tail: number;
    grep?: string;
    since?: string;
    previous?: boolean;
    container?: string;
  },
  target: ReturnType<typeof forwardTarget>,
): Promise<string> {
  const args = [wfName];
  if (pod) args.push(pod);
  args.push(`--tail=${options.tail}`);
  if (options.grep) args.push(`--grep=${options.grep}`);
  if (options.since) args.push(`--since=${options.since}`);
  if (options.previous) args.push("--previous");
  if (options.container) args.push(`--container=${options.container}`);
  const { stdout } = await runRead("wf.logs", args, {
    target,
    timeoutMs: 30_000,
  });
  return stdout;
}

function pickPod(wf: Workflow): { pod?: string; why: string } {
  const failed = failedLeafNodes(wf).filter((n) => n.type === "Pod");
  if (failed.length > 0) {
    const node = failed[failed.length - 1];
    return { pod: podNameOf(wf, node), why: `failed step ${nodeLabel(node)}` };
  }
  const pods = nodesOf(wf).filter((n) => n.type === "Pod");
  if (pods.length === 1) {
    return {
      pod: podNameOf(wf, pods[0]),
      why: `only step ${nodeLabel(pods[0])}`,
    };
  }
  return { why: `no failed step; all ${pluralize(pods.length, "pod")}` };
}

export async function wfLogs(args: string[]): Promise<Output> {
  if (args.includes("--help")) return WF_LOGS_HELP;
  const usage = "argo-workflows-axi wf logs <name|@latest> [<pod>]";
  const parsed = parseArgs(args, LOGS_SPEC, usage);
  const [name, podArg] = requirePositionals(parsed, 1, 2, usage);
  if (name !== "@latest") assertName(name, "workflow", usage);
  if (podArg) assertName(podArg, "pod", usage);
  const tail = parsePositiveInt(
    flagValue(parsed, "--tail") ?? "100",
    "--tail",
    5000,
  );
  const since = flagValue(parsed, "--since");
  if (since) parseDuration(since, "--since");
  const container = flagValue(parsed, "--container") ?? "main";
  assertName(container, "container", usage);

  const target = forwardTarget(parsed);
  const wf = await fetchWorkflow(name, target);
  const wfName = wf.metadata.name;
  const choice = podArg ? { pod: podArg, why: "requested" } : pickPod(wf);

  const raw = await fetchPodLog(
    wfName,
    choice.pod,
    {
      tail,
      grep: flagValue(parsed, "--grep"),
      since,
      previous: hasFlag(parsed, "--previous"),
      container,
    },
    target,
  );
  const full = hasFlag(parsed, "--full");
  const log = shapeLog(raw, choice.pod, full ? 1_000_000 : LOG_CHAR_CAP);
  const header: Record<string, unknown> = {
    workflow: `${wfName} (${phaseOf(wf)})`,
    pod: choice.pod ? `${choice.pod} (${choice.why})` : choice.why,
    container,
  };
  const suffix = targetSuffix(parsed);

  if (log.lines.length === 0) {
    header.log = "0 lines";
    header.help = [
      COMPLETED_PHASES.has(phaseOf(wf))
        ? "Pods may have been garbage-collected; logs of finished workflows need an artifact repository with archiveLogs"
        : "The pod may not have started yet",
      `Run \`argo-workflows-axi wf get ${wfName}${suffix}\` to check step phases`,
    ];
    return header;
  }

  header.lines = `${log.lines.length} shown (last ${tail} per pod${flagValue(parsed, "--grep") ? ", grep applied" : ""})`;
  if (log.truncated) {
    header.truncated = `kept the last ${log.text.length} of ${log.totalChars} chars`;
    header.help = [
      `Run \`argo-workflows-axi wf logs ${wfName}${suffix} --full\` for up to 1,000,000 log characters`,
    ];
  }
  header.log = log.lines;
  if (log.redactions > 0)
    header.redacted = `${log.redactions} sensitive values hidden (best effort)`;
  return header;
}

// ---------------------------------------------------------------- wf wait

export const WF_WAIT_HELP = `command: argo-workflows-axi wf wait <name>
description: Wait (bounded) for a workflow to finish, then print its summary. On timeout, prints the current state.
flags:
  --timeout <dur>: How long to wait (default 120s, max 10m)
  -n, --namespace <ns> | --context <name> | -s, --argo-server <host:port>
examples[2]:
  argo-workflows-axi wf wait nightly-etl-x7k2p
  argo-workflows-axi wf wait nightly-etl-x7k2p --timeout 5m
`;

const WAIT_SPEC = mergeSpecs(TARGET_FLAGS, { value: ["--timeout"] });
export const MAX_WAIT_SECONDS = 600;
const POLL_MS = 2_000;

export function parseTimeout(value: string | undefined): number {
  const seconds = parseDuration(value ?? "120s", "--timeout");
  if (seconds < 1 || seconds > MAX_WAIT_SECONDS) {
    throw axiError(
      `--timeout must be between 1s and 10m (got ${value})`,
      "VALIDATION_ERROR",
    );
  }
  return seconds;
}

export async function waitForCompletion(
  name: string,
  target: ReturnType<typeof forwardTarget>,
  timeoutSeconds: number,
): Promise<{ wf: Workflow; done: boolean }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const wf = await fetchWorkflow(name, target);
    if (COMPLETED_PHASES.has(phaseOf(wf))) return { wf, done: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { wf, done: false };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_MS, remaining)),
    );
  }
}

export async function wfWait(args: string[]): Promise<Output> {
  if (args.includes("--help")) return WF_WAIT_HELP;
  const usage = "argo-workflows-axi wf wait <name>";
  const parsed = parseArgs(args, WAIT_SPEC, usage);
  const [name] = requirePositionals(parsed, 1, 1, usage);
  assertName(name, "workflow", usage);
  const timeout = parseTimeout(flagValue(parsed, "--timeout"));

  const { wf, done } = await waitForCompletion(
    name,
    forwardTarget(parsed),
    timeout,
  );
  const suffix = targetSuffix(parsed);
  const out: Record<string, unknown> = {
    wait: done
      ? `finished: ${phaseOf(wf)}`
      : `timed out after ${timeout}s; still ${phaseOf(wf)}`,
    workflow: workflowSummary(wf),
  };
  const failed = failedNodeRows(wf, false);
  if (failed.length > 0) out.failed_nodes = failed;
  const redacted = redactValue(out);
  const result = redacted.value;
  if (redacted.count > 0)
    result.redacted = `${redacted.count} sensitive values hidden`;
  if (!done) {
    result.help = [
      `Run \`argo-workflows-axi wf wait ${wf.metadata.name}${suffix}\` to keep waiting`,
    ];
  } else if (failed.length > 0) {
    result.help = [
      `Run \`argo-workflows-axi wf logs ${wf.metadata.name}${suffix}\` for the failing step's logs`,
    ];
  }
  if (JSON.stringify(result).includes("(truncated,")) {
    result.help = [
      ...((result.help as string[] | undefined) ?? []),
      `Run \`argo-workflows-axi wf get ${wf.metadata.name} --full${suffix}\` for untruncated messages and parameters`,
    ];
  }
  return result;
}

// ---------------------------------------------------------------- lint

export const WF_LINT_HELP = `command: argo-workflows-axi wf lint <file...|->
description: Validate workflow manifests before submitting (read-only; asks the cluster or server to validate)
flags:
  -n, --namespace <ns> | --context <name> | -s, --argo-server <host:port>
examples[2]:
  argo-workflows-axi wf lint my-wf.yaml
  cat my-wf.yaml | argo-workflows-axi wf lint -
`;

/**
 * Names that mean "standard input". They are read through fd 0 rather than
 * reopened by path: on Linux, `/dev/stdin` is `/proc/self/fd/0`, and opening it
 * fails with ENXIO when stdin is a socket (as Node's spawn provides).
 */
const STDIN_PATHS = new Set([
  "-",
  "/dev/stdin",
  "/dev/fd/0",
  "/proc/self/fd/0",
]);

export function isStdinPath(file: string): boolean {
  return STDIN_PATHS.has(file);
}

/** Materialize stdin as a private temp file so argo never reads our stdin. */
export function withSpecFiles<T>(
  files: string[],
  fn: (paths: string[]) => Promise<T>,
): Promise<T> {
  if (!files.some(isStdinPath)) return fn(files);
  const dir = mkdtempSync(join(tmpdir(), "argo-workflows-axi-"));
  const path = join(dir, "stdin.yaml");
  writeFileSync(path, readFileSync(0), { mode: 0o600 });
  return fn(files.map((f) => (isStdinPath(f) ? path : f))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

const CONNECTION_FAILURES = new Set([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "SERVER_UNREACHABLE",
  "CONTEXT_NOT_FOUND",
  "RATE_LIMITED",
]);

export interface LintResult {
  ok: boolean;
  problems: string[];
}

export async function lintFiles(
  op: "wf.lint" | "template.lint",
  paths: string[],
  target: ReturnType<typeof forwardTarget>,
): Promise<LintResult> {
  const result = await runRead(op, [...paths, "--output=simple"], {
    target,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    const failure = mapArgoFailure(result.stderr);
    if (CONNECTION_FAILURES.has(failure.code)) throw failure;
  }
  const text = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const problems = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l && !/no linting errors found|^time=|level=(info|debug|warn)/i.test(l),
    );
  if (result.exitCode !== 0 && problems.length === 0) {
    // argo failed without saying why: that is a failed lint run, not "0 problems".
    throw mapArgoFailure(result.stderr || result.stdout);
  }
  return {
    ok: result.exitCode === 0,
    problems: result.exitCode === 0 ? [] : problems,
  };
}

export async function lintCommand(
  op: "wf.lint" | "template.lint",
  args: string[],
  help: string,
  usage: string,
): Promise<Output> {
  if (args.includes("--help")) return help;
  const parsed = parseArgs(args, TARGET_FLAGS, usage);
  const files = requirePositionals(parsed, 1, 20, usage);
  const target = forwardTarget(parsed);
  const resolved = await resolveTarget(parsed);
  const result = await withSpecFiles(files, (paths) =>
    lintFiles(op, paths, target),
  );
  if (result.ok) {
    return {
      lint: `ok - ${pluralize(files.length, "file")} valid`,
      target: describeTarget(resolved),
    };
  }
  const problems = redactValue(result.problems);
  const out: Record<string, unknown> = {
    lint: `${pluralize(result.problems.length, "problem")} found`,
    problems: problems.value,
    target: describeTarget(resolved),
  };
  if (problems.count > 0)
    out.redacted = `${problems.count} sensitive values hidden`;
  return out;
}

export function wfLint(args: string[]): Promise<Output> {
  return lintCommand(
    "wf.lint",
    args,
    WF_LINT_HELP,
    "argo-workflows-axi wf lint <file...|->",
  );
}
