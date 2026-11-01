import {
  ALL_NAMESPACES_FLAG,
  TARGET_FLAGS,
  assertName,
  flagValue,
  hasFlag,
  mergeSpecs,
  parseArgs,
  parsePositiveInt,
  requirePositionals,
} from "../args.js";
import {
  cronSchedule,
  describeParameters,
  getClusterTemplate,
  getCronWorkflow,
  getTemplate,
  listClusterTemplates,
  listCronWorkflows,
  listTemplates,
  type WorkflowTemplate,
} from "../cron-data.js";
import { axiError } from "../errors.js";
import { explicitTargetFlags } from "../gate.js";
import { age, truncateHead } from "../format.js";
import { redactValue } from "../redact.js";
import { parseJson, runRead } from "../seam.js";
import { forwardTarget, resolveTarget, targetSuffix } from "../target.js";
import {
  phaseOf,
  phaseTally,
  sortWorkflows,
  type Workflow,
} from "../workflow.js";
import { lintCommand, workflowSummary } from "./wf-read.js";

/** Read views over cron workflows, templates, cluster templates and the archive (W-c8, W-c9). */

type Output = Record<string, unknown> | string;

const TARGET_LINE =
  "  -n, --namespace <ns> | --context <name> | -s, --argo-server <host:port>";
const LIST_TARGET_LINE =
  "  -n, --namespace <ns> | -A, --all-namespaces | --context <name> | -s, --argo-server <host:port>";

function redacted(out: Record<string, unknown>): Record<string, unknown> {
  const r = redactValue(out);
  if (r.count > 0) r.value.redacted = `${r.count} sensitive values hidden`;
  return r.value;
}

// ---------------------------------------------------------------- cron

export const CRON_LIST_HELP = `command: argo-workflows-axi cron list
description: Cron workflows with schedule, suspended state and last run; suspended first
flags:
  -l, --selector <sel>: Label selector
${LIST_TARGET_LINE}
examples[2]:

  - argo-workflows-axi cron list
  - argo-workflows-axi cron list -A
`;

export const CRON_GET_HELP = `command: argo-workflows-axi cron get <name>
description: One cron workflow - schedule, timezone, suspended, concurrency, last run, active runs, entrypoint and parameters
flags:
  --full: Untruncated condition messages
${TARGET_LINE}
examples[1]:

  - argo-workflows-axi cron get nightly-etl
`;

export async function cronList(args: string[]): Promise<Output> {
  if (args.includes("--help")) return CRON_LIST_HELP;
  const usage = "argo-workflows-axi cron list";
  const parsed = parseArgs(
    args,
    mergeSpecs(TARGET_FLAGS, ALL_NAMESPACES_FLAG, {
      value: ["--selector"],
      aliases: { "-l": "--selector" },
    }),
    usage,
  );
  requirePositionals(parsed, 0, 0, usage);
  const all = hasFlag(parsed, "--all-namespaces");
  const target = await resolveTarget(parsed);
  const crons = await listCronWorkflows(
    forwardTarget(parsed),
    all,
    flagValue(parsed, "--selector"),
  );
  const scope = all
    ? "across all namespaces"
    : `in namespace ${target.namespace}`;
  const suffix = targetSuffix(parsed);
  if (crons.length === 0) {
    return { cron_workflows: `0 cron workflows ${scope}` };
  }
  const sorted = [...crons].sort(
    (a, b) =>
      Number(!!b.spec?.suspend) - Number(!!a.spec?.suspend) ||
      a.metadata.name.localeCompare(b.metadata.name),
  );
  const suspended = crons.filter((c) => c.spec?.suspend).length;
  return {
    count: `${crons.length} cron workflows ${scope} (${suspended} suspended)`,
    cron_workflows: sorted.map((c) => ({
      ...(all ? { namespace: c.metadata.namespace ?? "" } : {}),
      name: c.metadata.name,
      schedule: cronSchedule(c),
      suspended: c.spec?.suspend ? "yes" : "no",
      last_run: c.status?.lastScheduledTime
        ? `${age(c.status.lastScheduledTime)} ago`
        : "never",
    })),
    help: [
      `Run \`argo-workflows-axi cron get <name>${suffix}\` for parameters and active runs`,
      `Run \`argo-workflows-axi wf list --fields cron${suffix}\` to see which workflows came from crons`,
    ],
  };
}

export async function cronGet(args: string[]): Promise<Output> {
  if (args.includes("--help")) return CRON_GET_HELP;
  const usage = "argo-workflows-axi cron get <name>";
  const parsed = parseArgs(
    args,
    mergeSpecs(TARGET_FLAGS, { bool: ["--full"] }),
    usage,
  );
  const full = hasFlag(parsed, "--full");
  const [name] = requirePositionals(parsed, 1, 1, usage);
  assertName(name, "cron workflow", usage);
  const cron = await getCronWorkflow(name, forwardTarget(parsed));
  const spec = cron.spec ?? {};
  const status = cron.status ?? {};
  const out: Record<string, unknown> = {
    cron_workflow: {
      name: cron.metadata.name,
      namespace: cron.metadata.namespace ?? "",
      schedule: cronSchedule(cron),
      timezone: spec.timezone || "controller default (UTC)",
      suspended: spec.suspend ? "yes" : "no",
      concurrency: spec.concurrencyPolicy ?? "Allow",
      last_run: status.lastScheduledTime
        ? `${age(status.lastScheduledTime)} ago`
        : "never",
      active: (status.active ?? []).map((a) => a.name).join(", ") || "none",
      succeeded: status.succeeded ?? 0,
      failed: status.failed ?? 0,
      entrypoint: spec.workflowSpec?.entrypoint ?? "",
    },
  };
  const params = describeParameters(spec.workflowSpec?.arguments?.parameters);
  if (params.length > 0) out.parameters = params;
  const conditions = (status.conditions ?? []).filter(
    (c) => c.status === "True" && c.message,
  );
  if (conditions.length > 0) {
    out.conditions = conditions.map((c) => ({
      type: c.type ?? "",
      message: full
        ? (c.message ?? "")
        : truncateHead(c.message ?? "", 200).text,
    }));
  }
  if (!full && conditions.some((c) => (c.message?.length ?? 0) > 200)) {
    out.help = [
      `Run \`argo-workflows-axi cron get ${name} --full${targetSuffix(parsed)}\` for untruncated condition messages`,
    ];
  }
  return redacted(out);
}

// ---------------------------------------------------------------- templates

export const TEMPLATE_LIST_HELP = `command: argo-workflows-axi template list
description: WorkflowTemplates with their entrypoint and parameter count
flags:
  -l, --selector <sel>: Label selector
${LIST_TARGET_LINE}
examples[2]:

  - argo-workflows-axi template list
  - argo-workflows-axi template list -A
`;

export const TEMPLATE_GET_HELP = `command: argo-workflows-axi template get <name>
description: One WorkflowTemplate - entrypoint, input parameters with defaults, template names
flags:
${TARGET_LINE}
examples[1]:

  - argo-workflows-axi template get nightly-etl
`;

export const TEMPLATE_LINT_HELP = `command: argo-workflows-axi template lint <file...|->
description: Validate WorkflowTemplate manifests (read-only)
flags:
${TARGET_LINE}
examples[1]:

  - argo-workflows-axi template lint nightly-etl.yaml
`;

export const CLUSTERTEMPLATE_LIST_HELP = `command: argo-workflows-axi clustertemplate list
description: ClusterWorkflowTemplates (cluster-scoped) with their entrypoint and parameter count
flags:
  --context <name> | -s, --argo-server <host:port>
examples[1]:

  - argo-workflows-axi clustertemplate list
`;

export const CLUSTERTEMPLATE_GET_HELP = `command: argo-workflows-axi clustertemplate get <name>
description: One ClusterWorkflowTemplate - entrypoint, input parameters with defaults, template names
flags:
  --context <name> | -s, --argo-server <host:port>
examples[1]:

  - argo-workflows-axi clustertemplate get shared-build
`;

function templateRows(list: WorkflowTemplate[], withNamespace: boolean) {
  return [...list]
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    .map((t) => ({
      ...(withNamespace ? { namespace: t.metadata.namespace ?? "" } : {}),
      name: t.metadata.name,
      entrypoint: t.spec?.entrypoint ?? "",
      parameters: t.spec?.arguments?.parameters?.length ?? 0,
    }));
}

function templateDetail(
  t: WorkflowTemplate,
  kind: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [kind]: {
      name: t.metadata.name,
      ...(t.metadata.namespace ? { namespace: t.metadata.namespace } : {}),
      entrypoint:
        t.spec?.entrypoint ?? "(none - pass --entrypoint when submitting)",
      templates: (t.spec?.templates ?? []).map((x) => x.name).join(", "),
      ...(t.spec?.serviceAccountName
        ? { service_account: t.spec.serviceAccountName }
        : {}),
    },
  };
  const params = describeParameters(t.spec?.arguments?.parameters);
  out.parameters = params.length > 0 ? params : "none";
  return out;
}

export async function templateList(args: string[]): Promise<Output> {
  if (args.includes("--help")) return TEMPLATE_LIST_HELP;
  const usage = "argo-workflows-axi template list";
  const parsed = parseArgs(
    args,
    mergeSpecs(TARGET_FLAGS, ALL_NAMESPACES_FLAG, {
      value: ["--selector"],
      aliases: { "-l": "--selector" },
    }),
    usage,
  );
  requirePositionals(parsed, 0, 0, usage);
  const all = hasFlag(parsed, "--all-namespaces");
  const target = await resolveTarget(parsed);
  const list = await listTemplates(
    forwardTarget(parsed),
    all,
    flagValue(parsed, "--selector"),
  );
  const scope = all
    ? "across all namespaces"
    : `in namespace ${target.namespace}`;
  const suffix = targetSuffix(parsed);
  if (list.length === 0) {
    return {
      workflow_templates: `0 workflow templates ${scope}`,
      help: [
        `Run \`argo-workflows-axi clustertemplate list${suffix}\` for cluster-scoped templates`,
      ],
    };
  }
  return {
    count: `${list.length} workflow templates ${scope}`,
    workflow_templates: templateRows(list, all),
    help: [
      `Run \`argo-workflows-axi template get <name>${suffix}\` for its parameters`,
      `Run \`argo-workflows-axi wf submit --from workflowtemplate/<name>${suffix}\` to preview a submit`,
    ],
  };
}

export async function templateGet(args: string[]): Promise<Output> {
  if (args.includes("--help")) return TEMPLATE_GET_HELP;
  const usage = "argo-workflows-axi template get <name>";
  const parsed = parseArgs(args, TARGET_FLAGS, usage);
  const [name] = requirePositionals(parsed, 1, 1, usage);
  assertName(name, "workflow template", usage);
  const t = await getTemplate(name, forwardTarget(parsed));
  const out = templateDetail(t, "workflow_template");
  out.help = [
    `Run \`argo-workflows-axi wf submit --from workflowtemplate/${name}${targetSuffix(parsed)}\` to preview a submit`,
  ];
  return redacted(out);
}

export function templateLint(args: string[]): Promise<Output> {
  return lintCommand(
    "template.lint",
    args,
    TEMPLATE_LINT_HELP,
    "argo-workflows-axi template lint <file...|->",
  );
}

const CLUSTER_FLAGS = {
  value: ["--context", "--argo-server"],
  aliases: { "-s": "--argo-server" },
};

export async function clusterTemplateList(args: string[]): Promise<Output> {
  if (args.includes("--help")) return CLUSTERTEMPLATE_LIST_HELP;
  const usage = "argo-workflows-axi clustertemplate list";
  const parsed = parseArgs(args, CLUSTER_FLAGS, usage);
  requirePositionals(parsed, 0, 0, usage);
  const list = await listClusterTemplates(forwardTarget(parsed));
  const suffix = targetSuffix(parsed);
  if (list.length === 0)
    return { cluster_workflow_templates: "0 cluster workflow templates" };
  return {
    count: `${list.length} cluster workflow templates`,
    cluster_workflow_templates: templateRows(list, false),
    help: [
      `Run \`argo-workflows-axi clustertemplate get <name>${suffix}\` for its parameters`,
      `Run \`argo-workflows-axi wf submit --from clusterworkflowtemplate/<name> -n <namespace>${suffix}\` to preview a submit`,
    ],
  };
}

export async function clusterTemplateGet(args: string[]): Promise<Output> {
  if (args.includes("--help")) return CLUSTERTEMPLATE_GET_HELP;
  const usage = "argo-workflows-axi clustertemplate get <name>";
  const parsed = parseArgs(args, CLUSTER_FLAGS, usage);
  const [name] = requirePositionals(parsed, 1, 1, usage);
  assertName(name, "cluster workflow template", usage);
  const t = await getClusterTemplate(name, forwardTarget(parsed));
  return redacted(templateDetail(t, "cluster_workflow_template"));
}

// ---------------------------------------------------------------- archive

export const ARCHIVE_LIST_HELP = `command: argo-workflows-axi archive list
description: Archived workflows (Argo Server mode only), failing first
flags:
  -l, --selector <sel>: Label selector
  --limit <n>: Rows to show (default 50, max 1000)
${TARGET_LINE}
examples[2]:

  - argo-workflows-axi archive list
  - argo-workflows-axi archive list -l workflows.argoproj.io/phase=Failed
`;

export const ARCHIVE_GET_HELP = `command: argo-workflows-axi archive get <name>
description: One archived workflow (Argo Server mode only)
flags:
${TARGET_LINE}
examples[1]:

  - argo-workflows-axi archive get nightly-etl-x7k2p
`;

async function requireServerMode(parsed: ReturnType<typeof parseArgs>) {
  const target = await resolveTarget(parsed);
  if (target.mode !== "argo-server") {
    throw axiError(
      "The workflow archive is only available through an Argo Server (Kubernetes-API mode has no archive)",
      "UNSUPPORTED_IN_MODE",
      [
        "Set ARGO_SERVER or pass `--argo-server host:port` if this cluster runs an Argo Server with archiving",
        "Run `argo-workflows-axi wf list` for workflows still in the cluster",
      ],
    );
  }
  return target;
}

export async function archiveList(args: string[]): Promise<Output> {
  if (args.includes("--help")) return ARCHIVE_LIST_HELP;
  const usage = "argo-workflows-axi archive list";
  const parsed = parseArgs(
    args,
    mergeSpecs(TARGET_FLAGS, {
      value: ["--selector", "--limit"],
      aliases: { "-l": "--selector" },
    }),
    usage,
  );
  requirePositionals(parsed, 0, 0, usage);
  const limit = parsePositiveInt(
    flagValue(parsed, "--limit") ?? "50",
    "--limit",
    1000,
  );
  const target = await requireServerMode(parsed);
  const selector = flagValue(parsed, "--selector");
  const { stdout } = await runRead(
    "archive.list",
    ["--output=json", ...(selector ? [`--selector=${selector}`] : [])],
    { target: forwardTarget(parsed), timeoutMs: 60_000 },
  );
  const parsedList = parseJson<Workflow[] | null>(stdout, "archive list");
  const list = sortWorkflows(Array.isArray(parsedList) ? parsedList : []);
  const suffix = targetSuffix(parsed);
  if (list.length === 0)
    return {
      archived_workflows: `0 archived workflows in namespace ${target.namespace}`,
    };
  const shown = list.slice(0, limit);
  const out: Record<string, unknown> = {
    count: `${shown.length} of ${list.length} total in namespace ${target.namespace}`,
    phases: phaseTally(list),
    archived_workflows: shown.map((wf) => ({
      name: wf.metadata.name,
      phase: phaseOf(wf),
      finished: age(wf.status?.finishedAt),
      uid: wf.metadata.uid ?? "",
    })),
  };
  const help = [
    `Run \`argo-workflows-axi archive get <name>${suffix}\` for one archived workflow`,
  ];
  if (list.length > shown.length)
    help.push(
      `Run \`argo-workflows-axi archive list --limit ${Math.min(list.length, 1000)}${suffix}\` to see all ${list.length}`,
    );
  out.help = help;
  return out;
}

export async function archiveGet(args: string[]): Promise<Output> {
  if (args.includes("--help")) return ARCHIVE_GET_HELP;
  const usage = "argo-workflows-axi archive get <name>";
  const parsed = parseArgs(args, TARGET_FLAGS, usage);
  const [name] = requirePositionals(parsed, 1, 1, usage);
  assertName(name, "workflow", usage);
  const target = await requireServerMode(parsed);
  const forward = forwardTarget(parsed);

  // `argo archive get` takes only a UID before v4.1, so resolve the name to
  // its UID first; a bare UID works on every supported version.
  const listed = await runRead("archive.list", ["--output=json"], {
    target: forward,
    timeoutMs: 60_000,
  });
  const all = parseJson<Workflow[] | null>(listed.stdout, "archive list");
  const matches = (Array.isArray(all) ? all : [])
    .filter((wf) => wf.metadata.name === name && wf.metadata.uid)
    .sort((a, b) =>
      (
        b.status?.finishedAt ??
        b.metadata.creationTimestamp ??
        ""
      ).localeCompare(
        a.status?.finishedAt ?? a.metadata.creationTimestamp ?? "",
      ),
    );
  if (matches.length === 0) {
    throw axiError(
      `No archived workflow named ${name} in namespace ${target.namespace}`,
      "NOT_FOUND",
      [
        `Run \`argo-workflows-axi archive list${targetSuffix(parsed)}\` to see archived workflows`,
      ],
    );
  }
  const uid = matches[0].metadata.uid as string;
  const { stdout } = await runRead("archive.get", [uid, "--output=json"], {
    target: forward,
  });
  const wf = parseJson<Workflow>(stdout, "archived workflow");
  const out: Record<string, unknown> = {
    archived_workflow: workflowSummary(wf),
  };
  if (matches.length > 1) {
    out.matches = `${matches.length} archived runs are named ${name}; showing the newest (uid ${uid})`;
  }
  const result = redacted(out);
  if (JSON.stringify(result).includes("(truncated,")) {
    // No --full on archive get (not on the confirmed surface): the raw CLI is the fallback (S10).
    result.help = [
      // argo takes the same target flags, so the copied command lands on the same server.
      `Ask a human to run \`argo archive get ${uid} -o json ${explicitTargetFlags(target)}\` for untruncated values (raw argo output is not redacted)`,
    ];
  }
  return result;
}
