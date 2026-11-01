import { describe, expect, it } from "vitest";
import * as d from "./fixtures/data.js";
import {
  KUBE_DEFAULTS,
  argoCalls,
  json,
  run,
  writeCalls,
  type FakeResponse,
} from "./helpers.js";

const CRONS: FakeResponse[] = [
  {
    match: ["cron", "list", "--output=name"],
    stdout: "nightly-etl\nweekly-cleanup\n",
  },
  {
    match: ["cron", "get", "nightly-etl", "weekly-cleanup"],
    stdout:
      json(d.cron("nightly-etl", false)) + json(d.cron("weekly-cleanup", true)),
  },
];

describe("triage", () => {
  it("details failed workflows with step, hint and log tail; lists stuck and suspended crons; exit 0", () => {
    const etlPod = "nightly-etl-x7k2p-load-1234567890";
    const result = run(["triage"], {
      responses: [
        ...KUBE_DEFAULTS,
        ...CRONS,
        {
          match: ["list", "--output=json"],
          stdout: json([
            d.succeededReport(),
            d.failedEtl(),
            d.oomTrain(),
            d.runningIngest(),
            d.stuckPending(),
          ]),
        },
        {
          match: ["logs", "nightly-etl-x7k2p", etlPod],
          stdout: `${etlPod}: token=abc.def.ghi\n${etlPod}: ERROR load failed\n`,
        },
        {
          match: ["logs", "train-model-abc12"],
          stdout: "train-model-abc12: Killed\n",
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'summary: "2 failed, 1 stuck, 1 suspended crons"',
    );
    expect(result.stdout).toContain("step: load-warehouse (load)");
    expect(result.stdout).toContain(
      "hint: main container exited with code 1; read its logs",
    );
    expect(result.stdout).toContain("OOMKilled or SIGKILL (exit 137)");
    expect(result.stdout).toContain("log_tail[2]{line}:");
    expect(result.stdout).toContain("token=[redacted]");
    expect(result.stdout).not.toContain("abc.def.ghi");
    expect(result.stdout).toContain("redacted: 1 sensitive values hidden");
    expect(result.stdout).toContain("stuck[1]{name,phase,age,reason}:");
    expect(result.stdout).toContain(
      "suspended_crons[1]{name,schedule,last_run}:",
    );
    expect(writeCalls(result)).toEqual([]);
    // Log tails are bounded per workflow.
    expect(argoCalls(result).find((a) => a[0] === "logs")).toContain(
      "--tail=10",
    );
  });

  it("includes the workflow namespace in --full guidance with -A", () => {
    const wf = d.failedEtl();
    wf.metadata.namespace = "team-a";
    wf.status!.message = "x".repeat(500);
    const result = run(["triage", "-A"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["cron", "list"], stdout: "" },
        {
          match: ["list", "--output=json", "--all-namespaces"],
          stdout: json([wf]),
        },
        { match: ["logs"], stdout: "" },
      ],
    });
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf get nightly-etl-x7k2p -n team-a --full`",
    );
  });

  it("shows full message size and an exact wf get --full command", () => {
    const wf = d.failedEtl();
    wf.status!.message = "x".repeat(500);
    const result = run(["triage"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["cron", "list"], stdout: "" },
        { match: ["list", "--output=json"], stdout: json([wf]) },
        { match: ["logs"], stdout: "" },
      ],
    });
    expect(result.stdout).toContain("truncated, 500 chars total");
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf get nightly-etl-x7k2p --full`",
    );
  });

  it("ignores failures outside the window and says nothing is broken", () => {
    const old = d.failedEtl() as { status: Record<string, unknown> };
    old.status.finishedAt = d.ago(3 * 86400);
    const result = run(["triage"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["cron", "list"], stdout: "" },
        {
          match: ["list", "--output=json"],
          stdout: json([old, d.succeededReport()]),
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("triage: nothing broken in namespace argo");
  });

  it("supports -A across namespaces (argo's NAMESPACE NAME table for crons)", () => {
    const result = run(["triage", "-A"], {
      responses: [
        ...KUBE_DEFAULTS,
        {
          match: ["cron", "list", "--all-namespaces"],
          stdout:
            "NAMESPACE   NAME             AGE   LAST RUN   NEXT RUN   SCHEDULE    TIMEZONE   SUSPENDED\nteam-a      weekly-cleanup   30d   22h        2h         0 2 * * *   UTC        true\n",
        },
        {
          match: ["cron", "get", "weekly-cleanup", "--namespace=team-a"],
          stdout: json(d.cron("weekly-cleanup", true)),
        },
        { match: ["list", "--output=json", "--all-namespaces"], stdout: "[]" },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "suspended_crons[1]{namespace,name,schedule,last_run}:",
    );
  });
});

describe("triage window", () => {
  it("uses a fixed 24h window and 5 detailed workflows: --since and --limit are not flags", () => {
    for (const flag of [
      ["--since", "7d"],
      ["--limit", "10"],
    ]) {
      const result = run(["triage", ...flag]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain(`Unknown flag ${flag[0]}`);
      expect(result.calls).toEqual([]);
    }
  });
});

describe("cron and template reads", () => {
  it("cron list puts suspended first with schedule and last run", () => {
    const result = run(["cron", "list"], {
      responses: [...KUBE_DEFAULTS, ...CRONS],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "count: 2 cron workflows in namespace argo (1 suspended)",
    );
    expect(result.stdout).toMatch(
      /cron_workflows\[2\]\{name,schedule,suspended,last_run\}:\n {2}weekly-cleanup,/,
    );
  });

  it("cron get shows schedule details and parameters", () => {
    const result = run(["cron", "get", "nightly-etl"], {
      responses: [
        ...KUBE_DEFAULTS,
        {
          match: ["cron", "get", "nightly-etl"],
          stdout: json(d.cron("nightly-etl", false)),
        },
      ],
    });
    expect(result.stdout).toContain("timezone: Europe/Budapest");
    expect(result.stdout).toContain("concurrency: Forbid");
    expect(result.stdout).toContain("parameters[1]{name,default,enum}:");
  });

  it("truncates cron condition messages with a --full route", () => {
    const cron = d.cron("nightly-etl", false) as {
      status: { conditions: Array<Record<string, unknown>> };
    };
    cron.status.conditions = [
      { type: "Ready", status: "True", message: "x".repeat(500) },
    ];
    const responses = [
      ...KUBE_DEFAULTS,
      { match: ["cron", "get", "nightly-etl"], stdout: json(cron) },
    ];
    const preview = run(["cron", "get", "nightly-etl"], { responses });
    expect(preview.stdout).toContain("truncated, 500 chars total");
    expect(preview.stdout).toContain(
      "Run `argo-workflows-axi cron get nightly-etl --full`",
    );
    const full = run(["cron", "get", "nightly-etl", "--full"], { responses });
    expect(full.stdout).toContain("x".repeat(500));
  });

  it("template get shows entrypoint and parameters with defaults, redacting secrets", () => {
    const result = run(["template", "get", "nightly-etl"], {
      responses: [
        ...KUBE_DEFAULTS,
        {
          match: ["template", "get", "nightly-etl"],
          stdout: json(d.template()),
        },
      ],
    });
    expect(result.stdout).toContain("entrypoint: main");
    expect(result.stdout).toContain("date,(required),");
    expect(result.stdout).toContain("region,eu,eu|us");
    expect(result.stdout).toContain('api-token,"[redacted]",');
    expect(result.stdout).not.toContain("s3cr3t-default");
    expect(result.stdout).toContain(
      "wf submit --from workflowtemplate/nightly-etl",
    );
  });

  it("template list states an empty namespace and points at cluster templates", () => {
    const result = run(["template", "list"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["template", "list", "--output=name"], stdout: "" },
      ],
    });
    expect(result.stdout).toContain(
      "workflow_templates: 0 workflow templates in namespace argo",
    );
    expect(result.stdout).toContain("clustertemplate list");
  });

  it("clustertemplate list reads names then objects", () => {
    const result = run(["clustertemplate", "list"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["cluster-template", "list"], stdout: "shared-build\n" },
        {
          match: ["cluster-template", "get", "shared-build"],
          stdout: json(d.template("shared-build")),
        },
      ],
    });
    expect(result.stdout).toContain("count: 1 cluster workflow templates");
    expect(result.stdout).toContain("shared-build,main,3");
  });
});
