/**
 * Hand-built fixtures shaped after `argo ... -o json` output for v3.7 and
 * v4.1 (Workflow, CronWorkflow and WorkflowTemplate objects). They are not
 * recordings: recorded fixtures come from the separately approved real
 * verification pass.
 */

const NOW = Date.now();
export const ago = (seconds: number): string =>
  new Date(NOW - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function failedEtl(): Record<string, unknown> {
  const name = "nightly-etl-x7k2p";
  return {
    metadata: {
      name,
      namespace: "argo",
      uid: "11111111-2222-4333-8444-555555555555",
      creationTimestamp: ago(3 * 3600),
      labels: {
        "workflows.argoproj.io/phase": "Failed",
        "workflows.argoproj.io/cron-workflow": "nightly-etl",
      },
      annotations: { "workflows.argoproj.io/pod-name-format": "v2" },
    },
    spec: {
      entrypoint: "main",
      arguments: {
        parameters: [
          { name: "date", value: "2026-10-28" },
          { name: "db-password", value: "hunter2" },
        ],
      },
      workflowTemplateRef: { name: "nightly-etl" },
    },
    status: {
      phase: "Failed",
      message: "child 'nightly-etl-x7k2p-1234567890' failed",
      progress: "1/2",
      startedAt: ago(3 * 3600),
      finishedAt: ago(2 * 3600),
      nodes: {
        [name]: {
          id: name,
          name,
          displayName: name,
          type: "DAG",
          templateName: "main",
          phase: "Failed",
          startedAt: ago(3 * 3600),
          finishedAt: ago(2 * 3600),
          children: [`${name}-111`, `${name}-1234567890`],
        },
        [`${name}-111`]: {
          id: `${name}-111`,
          name: `${name}.extract`,
          displayName: "extract",
          type: "Pod",
          templateName: "extract",
          phase: "Succeeded",
          boundaryID: name,
          startedAt: ago(3 * 3600),
          finishedAt: ago(2.5 * 3600),
          outputs: { exitCode: "0" },
        },
        [`${name}-1234567890`]: {
          id: `${name}-1234567890`,
          name: `${name}.load-warehouse`,
          displayName: "load-warehouse",
          type: "Pod",
          templateName: "load",
          phase: "Failed",
          boundaryID: name,
          message: "Error (exit code 1)",
          startedAt: ago(2.5 * 3600),
          finishedAt: ago(2 * 3600),
          outputs: { exitCode: "1" },
        },
      },
    },
  };
}

export function oomTrain(): Record<string, unknown> {
  const name = "train-model-abc12";
  return {
    metadata: { name, namespace: "argo", creationTimestamp: ago(5 * 3600) },
    spec: { entrypoint: "train" },
    status: {
      phase: "Error",
      message: "OOMKilled (exit code 137)",
      startedAt: ago(5 * 3600),
      finishedAt: ago(4 * 3600),
      nodes: {
        [name]: {
          id: name,
          name,
          displayName: name,
          type: "Pod",
          templateName: "train",
          phase: "Error",
          message: "OOMKilled (exit code 137)",
          startedAt: ago(5 * 3600),
          finishedAt: ago(4 * 3600),
          outputs: { exitCode: "137" },
        },
      },
    },
  };
}

export function runningIngest(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const name = "ingest-q9w8e";
  return {
    metadata: { name, namespace: "argo", creationTimestamp: ago(600) },
    spec: { entrypoint: "main", ...extra },
    status: {
      phase: "Running",
      progress: "2/5",
      startedAt: ago(600),
      nodes: {
        [name]: {
          id: name,
          name,
          displayName: name,
          type: "Steps",
          phase: "Running",
          startedAt: ago(600),
        },
      },
    },
  };
}

export function succeededReport(): Record<string, unknown> {
  return {
    metadata: {
      name: "report-zz1",
      namespace: "argo",
      creationTimestamp: ago(7200),
    },
    spec: { entrypoint: "main" },
    status: {
      phase: "Succeeded",
      progress: "3/3",
      startedAt: ago(7200),
      finishedAt: ago(7000),
      nodes: {},
    },
  };
}

export function stuckPending(): Record<string, unknown> {
  return {
    metadata: {
      name: "stuck-pp1",
      namespace: "argo",
      creationTimestamp: ago(1200),
    },
    spec: { entrypoint: "main" },
    status: { phase: "Pending" },
  };
}

export function cron(name: string, suspend: boolean): Record<string, unknown> {
  return {
    metadata: { name, namespace: "argo", creationTimestamp: ago(30 * 86400) },
    spec: {
      schedule: "0 2 * * *",
      timezone: "Europe/Budapest",
      suspend,
      concurrencyPolicy: "Forbid",
      workflowSpec: {
        entrypoint: "main",
        arguments: { parameters: [{ name: "date", value: "today" }] },
      },
    },
    status: { lastScheduledTime: ago(22 * 3600), succeeded: 30, failed: 1 },
  };
}

export function template(name = "nightly-etl"): Record<string, unknown> {
  return {
    metadata: { name, namespace: "argo", creationTimestamp: ago(60 * 86400) },
    spec: {
      entrypoint: "main",
      arguments: {
        parameters: [
          { name: "date" },
          { name: "region", value: "eu", enum: ["eu", "us"] },
          { name: "api-token", value: "s3cr3t-default" },
        ],
      },
      templates: [{ name: "main" }, { name: "extract" }, { name: "load" }],
    },
  };
}
