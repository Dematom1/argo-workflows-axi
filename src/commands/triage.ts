import {
  ALL_NAMESPACES_FLAG,
  TARGET_FLAGS,
  hasFlag,
  mergeSpecs,
  parseArgs,
  requirePositionals,
} from "../args.js";
import { cronSchedule, listCronWorkflows } from "../cron-data.js";
import { errorMessage } from "../errors.js";
import { age, ageSeconds, truncateHead } from "../format.js";
import { redactValue } from "../redact.js";
import {
  describeTarget,
  forwardTarget,
  resolveTarget,
  targetSuffix,
} from "../target.js";
import {
  FAILED_PHASES,
  exitCodeOf,
  failedLeafNodes,
  failureHint,
  fetchWorkflow,
  fetchWorkflows,
  nodeLabel,
  nodeTemplate,
  nodesOf,
  phaseOf,
  podNameOf,
  type Workflow,
} from "../workflow.js";
import { fetchPodLog, shapeLog } from "./wf-read.js";

/**
 * One-call "what is broken" (design W7): failed and errored workflows with the
 * failing step, its message, exit-code or OOM hints and the last log lines;
 * workflows stuck Pending; suspended cron workflows. Unhealthy is data: exit 0.
 */

export const TRIAGE_HELP = `command: argo-workflows-axi triage
description: What is broken - failed and errored workflows with the failing step, hint and log tail; stuck Pending; suspended crons
flags:
  -n, --namespace <ns> | -A, --all-namespaces | --context <name> | -s, --argo-server <host:port>
examples[2]:
  argo-workflows-axi triage
  argo-workflows-axi triage -A
`;

const SPEC = mergeSpecs(TARGET_FLAGS, ALL_NAMESPACES_FLAG);
const WINDOW = "24h";
const WINDOW_SECONDS = 24 * 60 * 60;
const DETAILED = 5;
const STUCK_PENDING_SECONDS = 300;
const LOG_TAIL_LINES = 10;
const LOG_TAIL_CHARS = 1500;

function finishedWithin(wf: Workflow, seconds: number): boolean {
  const ref =
    wf.status?.finishedAt ??
    wf.status?.startedAt ??
    wf.metadata.creationTimestamp;
  const s = ageSeconds(ref);
  return s !== undefined && s <= seconds;
}

function stuckReason(wf: Workflow): string | undefined {
  const phase = phaseOf(wf);
  if (phase === "Pending" || phase === "Unknown") {
    const s = ageSeconds(wf.metadata.creationTimestamp);
    if (s !== undefined && s > STUCK_PENDING_SECONDS) {
      return (
        wf.status?.message ||
        "workflow not picked up by the controller (is it running? instanceid?)"
      );
    }
  }
  if (phase === "Running") {
    const pending = nodesOf(wf).find(
      (n) =>
        n.type === "Pod" &&
        n.phase === "Pending" &&
        (ageSeconds(n.startedAt) ?? 0) > STUCK_PENDING_SECONDS,
    );
    if (pending) {
      return `step ${nodeLabel(pending)} pending ${age(pending.startedAt)}${pending.message ? `: ${pending.message}` : ""}`;
    }
  }
  return undefined;
}

export async function triageCommand(
  args: string[],
): Promise<Record<string, unknown> | string> {
  if (args.includes("--help")) return TRIAGE_HELP;
  const usage = "argo-workflows-axi triage";
  const parsed = parseArgs(args, SPEC, usage);
  requirePositionals(parsed, 0, 0, usage);
  const all = hasFlag(parsed, "--all-namespaces");

  const target = await resolveTarget(parsed);
  const forward = forwardTarget(parsed);
  const suffix = targetSuffix(parsed);
  const scope = all ? "all namespaces" : `namespace ${target.namespace}`;

  const workflows = await fetchWorkflows(
    all ? ["--all-namespaces"] : [],
    forward,
  );
  const failed = workflows
    .filter(
      (wf) =>
        FAILED_PHASES.has(phaseOf(wf)) && finishedWithin(wf, WINDOW_SECONDS),
    )
    .sort((a, b) =>
      (b.status?.finishedAt ?? "").localeCompare(a.status?.finishedAt ?? ""),
    );
  const stuck = workflows
    .map((wf) => ({ wf, reason: stuckReason(wf) }))
    .filter(
      (s): s is { wf: Workflow; reason: string } => s.reason !== undefined,
    );

  let crons: string | Array<Record<string, string>>;
  let suspendedCount = 0;
  try {
    const list = await listCronWorkflows(forward, all);
    const suspended = list.filter((c) => c.spec?.suspend);
    suspendedCount = suspended.length;
    crons = suspended.map((c) => ({
      ...(all ? { namespace: c.metadata.namespace ?? "" } : {}),
      name: c.metadata.name,
      schedule: cronSchedule(c),
      last_run: c.status?.lastScheduledTime
        ? `${age(c.status.lastScheduledTime)} ago`
        : "never",
    }));
  } catch (error) {
    crons = `unavailable - ${errorMessage(error)}`;
  }

  const out: Record<string, unknown> = {
    target: describeTarget(target),
    window: `failures in the last ${WINDOW}`,
    summary: `${failed.length} failed, ${stuck.length} stuck, ${typeof crons === "string" ? "? " : suspendedCount} suspended crons`,
  };

  if (
    failed.length === 0 &&
    stuck.length === 0 &&
    suspendedCount === 0 &&
    typeof crons !== "string"
  ) {
    out.triage = `nothing broken in ${scope}`;
    return out;
  }

  let logRedactions = 0;
  if (failed.length > 0) {
    const detailed: Array<Record<string, unknown>> = [];
    for (const listed of failed.slice(0, DETAILED)) {
      let wf = listed;
      if (nodesOf(wf).length === 0) {
        try {
          wf = await fetchWorkflow(wf.metadata.name, {
            ...forward,
            namespace: wf.metadata.namespace ?? forward.namespace,
          });
        } catch {
          // Offloaded nodes we cannot fetch: show what the list had.
        }
      }
      const nodes = failedLeafNodes(wf);
      const step = nodes[nodes.length - 1];
      const entry: Record<string, unknown> = {};
      if (all) entry.namespace = wf.metadata.namespace ?? "";
      entry.workflow = wf.metadata.name;
      entry.phase = phaseOf(wf);
      entry.finished = `${age(wf.status?.finishedAt)} ago`;
      entry.message = truncateHead(wf.status?.message ?? "", 200).text;
      if (step) {
        entry.step = `${nodeLabel(step)} (${nodeTemplate(step) || step.type})`;
        const code = exitCodeOf(step);
        if (code) entry.exit_code = code;
        if (step.message && step.message !== wf.status?.message) {
          entry.step_message = truncateHead(step.message, 200).text;
        }
        const hint = failureHint(step);
        if (hint) entry.hint = hint;
        if (step.type === "Pod") {
          try {
            const pod = podNameOf(wf, step);
            const raw = await fetchPodLog(
              wf.metadata.name,
              pod,
              { tail: LOG_TAIL_LINES },
              {
                ...forward,
                namespace: wf.metadata.namespace ?? forward.namespace,
              },
            );
            const log = shapeLog(raw, pod, LOG_TAIL_CHARS);
            logRedactions += log.redactions;
            entry.log_tail =
              log.lines.length > 0
                ? log.lines.map((line) => ({ line }))
                : "0 lines (pod logs gone; needs archiveLogs)";
          } catch (error) {
            entry.log_tail = `unavailable - ${errorMessage(error)}`;
          }
        }
      }
      detailed.push(entry);
    }
    out.failed = detailed;
    if (failed.length > DETAILED) {
      out.failed_more = `${failed.length - DETAILED} more failed workflows not detailed`;
    }
  }

  if (stuck.length > 0) {
    out.stuck = stuck.map(({ wf, reason }) => ({
      ...(all ? { namespace: wf.metadata.namespace ?? "" } : {}),
      name: wf.metadata.name,
      phase: phaseOf(wf),
      age: age(wf.metadata.creationTimestamp),
      reason: truncateHead(reason, 200).text,
    }));
  }

  if (typeof crons === "string" || crons.length > 0) {
    out.suspended_crons = crons;
  }

  const help: string[] = [];
  if (failed.length > 0) {
    help.push(
      `Run \`argo-workflows-axi wf logs <workflow>${suffix}\` for more of the failing step's log`,
    );
    help.push(
      `Run \`argo-workflows-axi wf retry <workflow>${suffix}\` to preview a retry`,
    );
  }
  if (failed.length > DETAILED) {
    help.push(
      `Run \`argo-workflows-axi wf list --status Failed,Error --since ${WINDOW}${suffix}\` for all ${failed.length}`,
    );
  }
  if (suspendedCount > 0) {
    help.push(
      `Run \`argo-workflows-axi cron resume <name>${suffix}\` to preview resuming a cron`,
    );
  }
  const redacted = redactValue(out);
  const hidden = redacted.count + logRedactions;
  if (hidden > 0) redacted.value.redacted = `${hidden} sensitive values hidden`;
  if (help.length > 0) redacted.value.help = help;
  return redacted.value;
}
