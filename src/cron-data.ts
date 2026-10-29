import { runRead, parseJsonStream, type TargetArgs } from "./seam.js";
import type { Parameter } from "./workflow.js";

/**
 * CronWorkflow and template reads. `argo cron list` and `argo template list`
 * print tables or names only, so lists are name lookups followed by one
 * `get -o json` per namespace.
 */

export interface CronWorkflow {
  metadata: { name: string; namespace?: string; creationTimestamp?: string };
  spec?: {
    schedule?: string;
    schedules?: string[];
    timezone?: string;
    suspend?: boolean;
    concurrencyPolicy?: string;
    workflowSpec?: {
      entrypoint?: string;
      arguments?: { parameters?: Parameter[] };
    };
  };
  status?: {
    lastScheduledTime?: string;
    active?: Array<{ name: string }>;
    succeeded?: number;
    failed?: number;
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

export interface WorkflowTemplate {
  metadata: {
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    entrypoint?: string;
    arguments?: { parameters?: Parameter[] };
    templates?: Array<{ name: string }>;
    serviceAccountName?: string;
  };
}

export interface NamespacedName {
  namespace?: string;
  name: string;
}

/** Parse `-o name` output (one name per line). */
function parseNames(stdout: string, namespace?: string): NamespacedName[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("No "))
    .map((name) => ({ namespace, name }));
}

/** Parse the first two columns of an `-A` table (NAMESPACE NAME ...). */
function parseNamespacedTable(stdout: string): NamespacedName[] {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[0] !== "")
    .map(([namespace, name]) => ({ namespace, name }));
}

type Kind = "cron" | "template";

async function listNames(
  kind: Kind,
  target: TargetArgs,
  allNamespaces: boolean,
  selector?: string,
): Promise<NamespacedName[]> {
  const op = kind === "cron" ? "cron.list" : "template.list";
  const extra = selector ? [`--selector=${selector}`] : [];
  if (allNamespaces) {
    const { stdout } = await runRead(op, ["--all-namespaces", ...extra], {
      target,
    });
    return parseNamespacedTable(stdout);
  }
  const { stdout } = await runRead(op, ["--output=name", ...extra], { target });
  return parseNames(stdout, target.namespace);
}

async function getMany<T>(
  kind: Kind,
  names: NamespacedName[],
  target: TargetArgs,
): Promise<T[]> {
  const op = kind === "cron" ? "cron.get" : "template.get";
  const byNamespace = new Map<string | undefined, string[]>();
  for (const { namespace, name } of names) {
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), name]);
  }
  const out: T[] = [];
  for (const [namespace, list] of byNamespace) {
    const { stdout } = await runRead(op, [...list, "--output=json"], {
      target: { ...target, namespace: namespace ?? target.namespace },
      timeoutMs: 60_000,
    });
    out.push(...(parseJsonStream(stdout) as T[]));
  }
  return out;
}

export async function listCronWorkflows(
  target: TargetArgs,
  allNamespaces: boolean,
  selector?: string,
): Promise<CronWorkflow[]> {
  const names = await listNames("cron", target, allNamespaces, selector);
  return names.length === 0 ? [] : getMany<CronWorkflow>("cron", names, target);
}

export async function getCronWorkflow(
  name: string,
  target: TargetArgs,
): Promise<CronWorkflow> {
  const [cron] = await getMany<CronWorkflow>(
    "cron",
    [{ namespace: target.namespace, name }],
    target,
  );
  return cron;
}

export async function listTemplates(
  target: TargetArgs,
  allNamespaces: boolean,
  selector?: string,
): Promise<WorkflowTemplate[]> {
  const names = await listNames("template", target, allNamespaces, selector);
  return names.length === 0
    ? []
    : getMany<WorkflowTemplate>("template", names, target);
}

export async function getTemplate(
  name: string,
  target: TargetArgs,
): Promise<WorkflowTemplate> {
  const [tmpl] = await getMany<WorkflowTemplate>(
    "template",
    [{ namespace: target.namespace, name }],
    target,
  );
  return tmpl;
}

export async function listClusterTemplates(
  target: TargetArgs,
): Promise<WorkflowTemplate[]> {
  const { stdout } = await runRead("clustertemplate.list", ["--output=name"], {
    target,
  });
  const names = parseNames(stdout).map((n) => n.name);
  if (names.length === 0) return [];
  const got = await runRead(
    "clustertemplate.get",
    [...names, "--output=json"],
    {
      target,
      timeoutMs: 60_000,
    },
  );
  return parseJsonStream(got.stdout) as WorkflowTemplate[];
}

export async function getClusterTemplate(
  name: string,
  target: TargetArgs,
): Promise<WorkflowTemplate> {
  const { stdout } = await runRead(
    "clustertemplate.get",
    [name, "--output=json"],
    { target },
  );
  return parseJsonStream(stdout)[0] as WorkflowTemplate;
}

export function cronSchedule(cron: CronWorkflow): string {
  const spec = cron.spec ?? {};
  const schedules = spec.schedules?.length
    ? spec.schedules
    : spec.schedule
      ? [spec.schedule]
      : [];
  return schedules.join(" | ");
}

/** Template input parameters with defaults, for previews and `template get`. */
export function describeParameters(
  params: Parameter[] | undefined,
): Array<Record<string, string>> {
  return (params ?? []).map((p) => ({
    name: p.name,
    default: p.value ?? p.default ?? "(required)",
    enum: p.enum?.join("|") ?? "",
  }));
}
