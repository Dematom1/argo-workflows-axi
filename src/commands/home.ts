import { parseArgs } from "../args.js";
import { listCronWorkflows } from "../cron-data.js";
import { errorMessage } from "../errors.js";
import { age, truncateHead } from "../format.js";
import { redactValue } from "../redact.js";
import { describeTarget, forwardTarget, resolveTarget } from "../target.js";
import {
  FAILED_PHASES,
  fetchWorkflows,
  phaseOf,
  phaseTally,
  type Workflow,
} from "../workflow.js";
import { argoClientVersion } from "./ctx.js";

/**
 * No-argument home view (AXI principle 8, design W-c1): live state, problems
 * first. Every sub-call degrades to `unavailable - reason` with exit 0.
 */

const SHOWN = 5;

function unavailable(error: unknown): string {
  return `unavailable - ${errorMessage(error)}`;
}

export async function homeView(): Promise<Record<string, unknown>> {
  const parsed = parseArgs([], {}, "argo-workflows-axi");
  const [target, version] = await Promise.all([
    resolveTarget(parsed),
    argoClientVersion(),
  ]);
  const forward = forwardTarget(parsed);
  const out: Record<string, unknown> = { target: describeTarget(target) };

  if (!version.version || version.note !== "supported") {
    out.argo = version.version
      ? `v${version.version} - ${version.note}`
      : version.note;
  }

  let workflows: Workflow[] | undefined;
  try {
    workflows = await fetchWorkflows([], forward);
  } catch (error) {
    out.workflows = unavailable(error);
  }

  const help: string[] = [];
  if (workflows) {
    if (workflows.length === 0) {
      out.workflows = `0 workflows in namespace ${target.namespace}`;
      help.push(
        "Run `argo-workflows-axi template list` to see templates you can submit from",
      );
    } else {
      out.workflows = `${workflows.length} total (${phaseTally(workflows)})`;
      const failed = workflows
        .filter((wf) => FAILED_PHASES.has(phaseOf(wf)))
        .sort((a, b) =>
          (b.status?.finishedAt ?? "").localeCompare(
            a.status?.finishedAt ?? "",
          ),
        );
      const running = workflows.filter((wf) =>
        ["Running", "Pending"].includes(phaseOf(wf)),
      );

      if (failed.length > 0) {
        out.failed = failed.slice(0, SHOWN).map((wf) => ({
          name: wf.metadata.name,
          phase: phaseOf(wf),
          finished: age(wf.status?.finishedAt),
          message: truncateHead(wf.status?.message ?? "", 120).text,
        }));
        help.push(
          "Run `argo-workflows-axi triage` for failing steps, hints and log tails",
        );
        help.push(
          "Run `argo-workflows-axi wf get <name>` for one workflow's failed steps",
        );
      }
      if (running.length > 0) {
        out.running = running.slice(0, SHOWN).map((wf) => ({
          name: wf.metadata.name,
          phase: phaseOf(wf),
          age: age(wf.status?.startedAt ?? wf.metadata.creationTimestamp),
          progress: wf.status?.progress ?? "",
        }));
      }
      if (failed.length > SHOWN || running.length > SHOWN) {
        help.push(
          `Run \`argo-workflows-axi wf list\` to show up to 1000 of ${workflows.length} workflows`,
        );
      }
    }
  }

  try {
    const crons = await listCronWorkflows(forward, false);
    const suspended = crons.filter((c) => c.spec?.suspend).length;
    out.cron =
      crons.length === 0
        ? "0 cron workflows"
        : `${crons.length} cron workflows (${suspended} suspended)`;
    if (crons.length > 0)
      help.push(
        "Run `argo-workflows-axi cron list` for schedules and last runs",
      );
  } catch (error) {
    out.cron = unavailable(error);
  }

  if (!workflows) {
    help.push(
      "Run `argo-workflows-axi ctx` to check which context or server is targeted",
    );
  } else if (help.length === 0) {
    help.push("Run `argo-workflows-axi wf list` to list workflows");
  }
  help.push("Run `argo-workflows-axi --help` for all commands");
  const redacted = redactValue(out);
  if (redacted.count > 0)
    redacted.value.redacted = `${redacted.count} sensitive values hidden`;
  redacted.value.help = help;
  return redacted.value;
}
