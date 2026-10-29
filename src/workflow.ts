import { runRead, parseJson, type TargetArgs } from "./seam.js";

/** The parts of the Argo Workflow object this tool reads (v3.7 - v4.1 shapes). */
export interface Parameter {
  name: string;
  value?: string;
  default?: string;
  description?: string;
  enum?: string[];
}

export interface WfNode {
  id: string;
  name: string;
  displayName?: string;
  type: string;
  templateName?: string;
  templateRef?: { name?: string; template?: string; clusterScope?: boolean };
  phase?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  boundaryID?: string;
  children?: string[];
  outputs?: { exitCode?: string; parameters?: Parameter[] };
}

export interface Workflow {
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    entrypoint?: string;
    suspend?: boolean;
    shutdown?: string;
    arguments?: { parameters?: Parameter[] };
    workflowTemplateRef?: { name?: string; clusterScope?: boolean };
    serviceAccountName?: string;
  };
  status?: {
    phase?: string;
    message?: string;
    progress?: string;
    startedAt?: string;
    finishedAt?: string;
    estimatedDuration?: number;
    nodes?: Record<string, WfNode>;
  };
}

export const COMPLETED_PHASES = new Set(["Succeeded", "Failed", "Error"]);
export const FAILED_PHASES = new Set(["Failed", "Error"]);
const LEAF_TYPES = new Set(["Pod", "Container", "HTTP", "Plugin", "Suspend"]);

export function phaseOf(wf: Workflow): string {
  return wf.status?.phase || "Unknown";
}

export function isCompleted(wf: Workflow): boolean {
  return COMPLETED_PHASES.has(phaseOf(wf));
}

const PHASE_RANK: Record<string, number> = {
  Failed: 0,
  Error: 0,
  Running: 1,
  Pending: 2,
  Unknown: 3,
  Succeeded: 4,
};

/** Problems first, then running, then the rest; newest first within a group. */
export function sortWorkflows(list: Workflow[]): Workflow[] {
  return [...list].sort((a, b) => {
    const rank = (PHASE_RANK[phaseOf(a)] ?? 3) - (PHASE_RANK[phaseOf(b)] ?? 3);
    if (rank !== 0) return rank;
    return (b.metadata.creationTimestamp ?? "").localeCompare(
      a.metadata.creationTimestamp ?? "",
    );
  });
}

export function phaseTally(list: Workflow[]): string {
  const counts = new Map<string, number>();
  for (const wf of list) {
    counts.set(phaseOf(wf), (counts.get(phaseOf(wf)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (PHASE_RANK[a[0]] ?? 3) - (PHASE_RANK[b[0]] ?? 3))
    .map(([phase, n]) => `${phase} ${n}`)
    .join(", ");
}

export function nodesOf(wf: Workflow): WfNode[] {
  return Object.values(wf.status?.nodes ?? {});
}

export function nodeLabel(node: WfNode): string {
  return node.displayName || node.name;
}

export function nodeTemplate(node: WfNode): string {
  if (node.templateName) return node.templateName;
  if (node.templateRef?.template) {
    return node.templateRef.name
      ? `${node.templateRef.name}/${node.templateRef.template}`
      : node.templateRef.template;
  }
  return "";
}

/** Failed or errored leaf nodes (the steps that actually broke), oldest failure first. */
export function failedLeafNodes(wf: Workflow): WfNode[] {
  const failed = nodesOf(wf).filter((n) => FAILED_PHASES.has(n.phase ?? ""));
  const leaves = failed.filter((n) => LEAF_TYPES.has(n.type));
  const picked = leaves.length > 0 ? leaves : failed.filter((n) => n.message);
  return picked.sort((a, b) =>
    (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""),
  );
}

export function exitCodeOf(node: WfNode): string | undefined {
  if (node.outputs?.exitCode !== undefined && node.outputs.exitCode !== "") {
    return String(node.outputs.exitCode);
  }
  const match = /exit code (\d+)/i.exec(node.message ?? "");
  return match?.[1];
}

/** A short, actionable reading of why a step failed (W7: exit-code and OOM hints). */
export function failureHint(node: WfNode): string | undefined {
  const message = node.message ?? "";
  const code = exitCodeOf(node);
  if (/OOMKilled/i.test(message) || code === "137") {
    return "OOMKilled or SIGKILL (exit 137): the container likely exceeded its memory limit; raise resources.limits.memory";
  }
  if (/ImagePullBackOff|ErrImagePull|InvalidImageName/i.test(message)) {
    return "image pull failed: check the image name, tag and imagePullSecrets";
  }
  if (/activeDeadlineSeconds|deadline exceeded/i.test(message)) {
    return "hit its deadline (activeDeadlineSeconds); the step ran too long";
  }
  if (/pod deleted|was deleted|evicted/i.test(message)) {
    return "pod was deleted or evicted (node pressure, preemption or manual delete)";
  }
  if (/Unschedulable|Insufficient (cpu|memory)/i.test(message)) {
    return "pod could not be scheduled: not enough cluster capacity or no matching node";
  }
  if (code === "143") {
    return "terminated by SIGTERM (exit 143): stopped, timed out or evicted";
  }
  if (code && code !== "0") {
    return `main container exited with code ${code}; read its logs`;
  }
  return undefined;
}

const MAX_K8S_NAME = 253;
const MAX_PREFIX = MAX_K8S_NAME - 10;

/** Pod name for a Pod node (mirrors Argo's pod name v2 rules; v1 uses the node id). */
export function podNameOf(wf: Workflow, node: WfNode): string {
  const format =
    wf.metadata.annotations?.["workflows.argoproj.io/pod-name-format"];
  if (format === "v1") return node.id;

  const wfName = wf.metadata.name;
  if (wfName === node.name) return wfName;

  let prefix = wfName;
  const template = node.templateName || node.templateRef?.template || "";
  if (template) prefix = `${prefix}-${template}`;
  if (prefix.length > MAX_PREFIX - 1) prefix = prefix.slice(0, MAX_PREFIX - 1);

  const hash = node.id.startsWith(`${wfName}-`)
    ? node.id.slice(wfName.length + 1)
    : node.id;
  const excess = prefix.length + 1 + hash.length - MAX_K8S_NAME;
  if (excess > 0) prefix = prefix.slice(0, prefix.length - excess);
  return `${prefix}-${hash}`;
}

export async function fetchWorkflow(
  name: string,
  target: TargetArgs,
): Promise<Workflow> {
  const { stdout } = await runRead("wf.get", [name, "--output=json"], {
    target,
  });
  return parseJson<Workflow>(stdout, `workflow ${name}`);
}

export async function fetchWorkflows(
  args: string[],
  target: TargetArgs,
): Promise<Workflow[]> {
  const { stdout } = await runRead("wf.list", ["--output=json", ...args], {
    target,
    timeoutMs: 60_000,
  });
  const parsed = parseJson<Workflow[] | null>(stdout, "workflow list");
  return Array.isArray(parsed) ? parsed : [];
}

/** Whether the workflow is suspended (spec.suspend, or a running suspend node). */
export function isSuspended(wf: Workflow): boolean {
  if (wf.spec?.suspend) return true;
  return nodesOf(wf).some((n) => n.type === "Suspend" && n.phase === "Running");
}
