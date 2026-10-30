import { describe, expect, it } from "vitest";
import * as d from "./fixtures/data.js";
import { KUBE_DEFAULTS, argoCalls, json, run, writeCalls } from "./helpers.js";

const WORKFLOWS = [
  d.succeededReport(),
  d.failedEtl(),
  d.runningIngest(),
  d.oomTrain(),
  d.stuckPending(),
];

describe("wf list", () => {
  it("sorts failing and running first and reports count and tally", () => {
    const result = run(["wf", "list"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["list", "--output=json"], stdout: json(WORKFLOWS) },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("count: 5 of 5 total in namespace argo");
    const rows = result.stdout
      .split("\n")
      .filter((l) => l.startsWith("  ") && !l.startsWith("  Run"));
    expect(rows.map((r) => r.trim().split(",")[1])).toEqual([
      "Failed",
      "Error",
      "Running",
      "Pending",
      "Succeeded",
    ]);
    expect(result.stdout).toContain("workflows[5]{name,phase,age,message}:");
  });

  it("counts secrets masked in the message column", () => {
    const leaky = d.failedEtl() as { status: Record<string, unknown> };
    leaky.status.message = "connect failed password=hunter2";
    const result = run(["wf", "list"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["list", "--output=json"], stdout: json([leaky]) },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hunter2");
    expect(result.stdout).toContain("redacted: 1 sensitive values hidden");
  });

  it("forwards filters with argo's own flag names and validates them first", () => {
    const result = run(
      [
        "wf",
        "list",
        "--status",
        "failed,error",
        "--since",
        "1d",
        "-l",
        "app=etl",
        "--prefix",
        "nightly-",
        "-A",
      ],
      {
        responses: [...KUBE_DEFAULTS, { match: ["list"], stdout: "[]" }],
      },
    );
    expect(result.exitCode).toBe(0);
    expect(argoCalls(result)[0]).toEqual([
      "list",
      "--output=json",
      "--status=Failed,Error",
      "--since=1d",
      "--selector=app=etl",
      "--prefix=nightly-",
      "--all-namespaces",
      "--loglevel=error",
    ]);
    expect(result.stdout).toContain(
      "workflows: 0 workflows matching these filters across all namespaces",
    );
  });

  it("rejects an unknown phase and an unknown field before calling argo", () => {
    expect(run(["wf", "list", "--status", "Broken"]).stdout).toContain(
      "Valid phases: Pending, Running",
    );
    const fields = run(["wf", "list", "--fields", "colour"]);
    expect(fields.exitCode).toBe(2);
    expect(fields.stdout).toContain("Valid fields: namespace, started");
    expect(fields.calls).toEqual([]);
  });

  it("preserves filters and all-namespace scope in expansion hints", () => {
    const result = run(
      [
        "wf",
        "list",
        "--limit",
        "1",
        "--status",
        "Failed",
        "-A",
        "--prefix",
        "nightly-",
      ],
      {
        responses: [
          ...KUBE_DEFAULTS,
          { match: ["list"], stdout: json(WORKFLOWS) },
        ],
      },
    );
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf list --limit 1000 --status Failed --prefix nightly- -A` to show up to 1000 matching workflows",
    );
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf get <name> -n <namespace>" +
        "` for phase, parameters and failed steps",
    );
  });

  it("quotes whitespace in reconstructed filter values", () => {
    const result = run(
      ["wf", "list", "--limit", "1", "--prefix", "nightly batch"],
      {
        responses: [
          ...KUBE_DEFAULTS,
          { match: ["list"], stdout: json(WORKFLOWS) },
        ],
      },
    );
    expect(result.stdout).toContain("--prefix 'nightly batch'");
  });

  it("does not promise to show more than the 1000-row limit", () => {
    const result = run(["wf", "list", "--limit", "1"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["list"], stdout: json(Array(1001).fill(WORKFLOWS[0])) },
      ],
    });
    expect(result.stdout).toContain("to show up to 1000 matching workflows");
    expect(result.stdout).not.toContain("to see all 1001");
  });

  it("adds a namespace column with -A and extra --fields columns", () => {
    const result = run(["wf", "list", "-A", "--fields", "duration,cron"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["list"], stdout: json([d.failedEtl()]) },
      ],
    });
    expect(result.stdout).toContain(
      "workflows[1]{namespace,name,phase,age,message,duration,cron}:",
    );
    expect(result.stdout).toContain("argo,nightly-etl-x7k2p,Failed");
  });
});

describe("wf get", () => {
  it("truncates long parameter values unless --full", () => {
    const big = d.failedEtl() as {
      spec: {
        arguments: { parameters: Array<{ name: string; value: string }> };
      };
    };
    big.spec.arguments.parameters.push({
      name: "payload",
      value: "x".repeat(5000),
    });
    const responses = [
      ...KUBE_DEFAULTS,
      { match: ["get", "nightly-etl-x7k2p"], stdout: json(big) },
    ];
    const short = run(["wf", "get", "nightly-etl-x7k2p"], { responses });
    expect(short.stdout).toContain("(truncated, 5000 chars total)");
    expect(short.stdout).not.toContain("x".repeat(201));
    const full = run(["wf", "get", "nightly-etl-x7k2p", "--full"], {
      responses,
    });
    expect(full.stdout).toContain("x".repeat(5000));
  });

  it("shows the summary, only failed nodes with hints, and redacts sensitive parameters", () => {
    const result = run(["wf", "get", "nightly-etl-x7k2p"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get", "nightly-etl-x7k2p"], stdout: json(d.failedEtl()) },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("phase: Failed");
    expect(result.stdout).toContain("template: workflowtemplate/nightly-etl");
    expect(result.stdout).toContain('db-password,"[redacted]"');
    expect(result.stdout).not.toContain("hunter2");
    expect(result.stdout).toContain("redacted: 1 sensitive values hidden");
    expect(result.stdout).toContain(
      "nodes: 1 of 3 nodes shown (failed and errored only)",
    );
    expect(result.stdout).toContain(
      'load-warehouse,load,Failed,"1",Error (exit code 1),main container exited with code 1; read its logs,nightly-etl-x7k2p-load-1234567890',
    );
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf logs nightly-etl-x7k2p` for the failing step's logs",
    );
  });

  it("passes @latest through and carries target flags into hints", () => {
    const result = run(["wf", "get", "@latest", "-n", "argo"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get", "@latest"], stdout: json(d.runningIngest()) },
      ],
    });
    expect(argoCalls(result)[0]).toEqual([
      "get",
      "@latest",
      "--output=json",
      "--namespace=argo",
      "--loglevel=error",
    ]);
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf wait ingest-q9w8e -n argo` to wait (bounded)",
    );
  });

  it("renders the node tree with --tree", () => {
    const result = run(["wf", "get", "nightly-etl-x7k2p", "--tree"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get"], stdout: json(d.failedEtl()) },
      ],
    });
    expect(result.stdout).toContain("tree[3]:");
    expect(result.stdout).toContain("nightly-etl-x7k2p | DAG | Failed");
    expect(result.stdout).toContain("  load-warehouse | Pod | Failed");
  });

  it("uses --full for tree messages and hints only when a message is truncated", () => {
    const wf = d.failedEtl();
    const node = Object.values(wf.status?.nodes ?? {}).find(
      (n) => n.type === "Pod" && n.phase === "Failed",
    );
    if (!node) throw new Error("fixture lacks failed pod");
    node.message = "x".repeat(100);
    const responses = [...KUBE_DEFAULTS, { match: ["get"], stdout: json(wf) }];
    const preview = run(["wf", "get", "nightly-etl-x7k2p", "--tree"], {
      responses,
    });
    expect(preview.stdout).toContain("truncated, 100 chars total");
    expect(preview.stdout).toContain("--tree --full");
    const full = run(["wf", "get", "nightly-etl-x7k2p", "--tree", "--full"], {
      responses,
    });
    expect(full.stdout).toContain(`${"x".repeat(100)} (100 chars)`);
    expect(full.stdout).not.toContain("--tree --full");
  });

  it("maps argo's NotFound to NOT_FOUND with exit 1", () => {
    const result = run(["wf", "get", "nope"], {
      responses: [
        ...KUBE_DEFAULTS,
        {
          match: ["get", "nope"],
          stderr:
            'time="2026-10-28T10:00:00.000Z" level=fatal msg="rpc error: code = NotFound desc = workflows.argoproj.io \\"nope\\" not found"\n',
          exit: 1,
        },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: NOT_FOUND");
    expect(result.stdout).toContain(
      'workflows.argoproj.io \\"nope\\" not found',
    );
  });
});

describe("wf logs", () => {
  it("picks the failed step's pod, strips the pod prefix and redacts secrets", () => {
    const pod = "nightly-etl-x7k2p-load-1234567890";
    const result = run(["wf", "logs", "nightly-etl-x7k2p"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get", "nightly-etl-x7k2p"], stdout: json(d.failedEtl()) },
        {
          match: ["logs", "nightly-etl-x7k2p", pod],
          stdout: `${pod}: connecting with password=hunter2\n${pod}: ERROR load failed\n`,
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`pod: ${pod} (failed step load-warehouse)`);
    expect(result.stdout).toContain("log[2]:");
    expect(result.stdout).toContain("connecting with password=[redacted]");
    expect(result.stdout).toContain("ERROR load failed");
    expect(result.stdout).not.toContain("--- log ---");
    expect(result.stdout).not.toContain("hunter2");
    expect(argoCalls(result)[1]).toEqual([
      "logs",
      "nightly-etl-x7k2p",
      pod,
      "--tail=100",
      "--container=main",
      "--loglevel=error",
    ]);
  });

  it("caps output at 20k chars and --full expands the bounded cap", () => {
    const pod = "nightly-etl-x7k2p-load-1234567890";
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `${pod}: line ${String(i).padStart(5, "0")} ${"x".repeat(40)}`,
    );
    const result = run(["wf", "logs", "nightly-etl-x7k2p", "--tail", "2000"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get"], stdout: json(d.failedEtl()) },
        { match: ["logs"], stdout: `${lines.join("\n")}\n` },
      ],
    });
    expect(result.stdout).toMatch(/truncated: kept the last \d+ of \d+ chars/);
    expect(result.stdout).toContain("line 01999");
    expect(result.stdout).not.toContain("line 00000");
    expect(result.stdout).toContain("--full");
    expect(result.stdout).not.toContain("line 00000");
    const full = run(
      ["wf", "logs", "nightly-etl-x7k2p", "--tail", "2000", "--full"],
      {
        responses: [
          ...KUBE_DEFAULTS,
          { match: ["get"], stdout: json(d.failedEtl()) },
          { match: ["logs"], stdout: `${lines.join("\n")}\n` },
        ],
      },
    );
    expect(full.stdout).toContain("line 00000");
    expect(full.stdout).not.toContain("truncated:");
  });

  it("states an empty log definitively", () => {
    const result = run(["wf", "logs", "nightly-etl-x7k2p"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get"], stdout: json(d.failedEtl()) },
        { match: ["logs"], stdout: "" },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("log: 0 lines");
    expect(result.stdout).toContain("archiveLogs");
  });

  it("forwards --grep, --since, --previous and -c", () => {
    const result = run(
      [
        "wf",
        "logs",
        "nightly-etl-x7k2p",
        "--grep",
        "ERROR",
        "--since",
        "10m",
        "--previous",
        "-c",
        "wait",
      ],
      {
        responses: [
          ...KUBE_DEFAULTS,
          { match: ["get"], stdout: json(d.failedEtl()) },
          { match: ["logs"], stdout: "" },
        ],
      },
    );
    expect(argoCalls(result)[1]).toEqual(
      expect.arrayContaining([
        "--grep=ERROR",
        "--since=10m",
        "--previous",
        "--container=wait",
      ]),
    );
  });
});

describe("wf wait", () => {
  it("points at wf get --full when the summary was truncated", () => {
    const done = {
      ...d.runningIngest(),
      spec: {
        entrypoint: "main",
        arguments: {
          parameters: [{ name: "payload", value: "y".repeat(900) }],
        },
      },
      status: {
        phase: "Succeeded",
        startedAt: d.ago(600),
        finishedAt: d.ago(1),
      },
    };
    const result = run(["wf", "wait", "ingest-q9w8e", "--timeout", "5s"], {
      responses: [...KUBE_DEFAULTS, { match: ["get"], stdout: json(done) }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(truncated, 900 chars total)");
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf get ingest-q9w8e --full`",
    );
  });

  it("returns the current state and a hint when the bounded wait times out (exit 0)", () => {
    const result = run(["wf", "wait", "ingest-q9w8e", "--timeout", "1s"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get", "ingest-q9w8e"], stdout: json(d.runningIngest()) },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wait: timed out after 1s; still Running");
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi wf wait ingest-q9w8e` to keep waiting",
    );
  });

  it("returns the final summary when the workflow finishes", () => {
    const done = {
      ...d.runningIngest(),
      status: {
        phase: "Succeeded",
        startedAt: d.ago(600),
        finishedAt: d.ago(1),
      },
    };
    const result = run(["wf", "wait", "ingest-q9w8e", "--timeout", "10s"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get"], stdout: json(d.runningIngest()), times: 1 },
        { match: ["get"], stdout: json(done) },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wait: "finished: Succeeded"');
  });

  it("takes a workflow name only, not @latest", () => {
    const result = run(["wf", "wait", "@latest"]);
    expect(result.exitCode).toBe(2);
    expect(result.calls).toEqual([]);
  });

  it("refuses timeouts above 10m", () => {
    const result = run(["wf", "wait", "x", "--timeout", "11m"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--timeout must be between 1s and 10m");
  });
});

describe("lint", () => {
  it("treats a failed lint run with no output as an error, not 0 problems", () => {
    const result = run(["wf", "lint", "x.yaml"], {
      responses: [...KUBE_DEFAULTS, { match: ["lint"], stdout: "", exit: 1 }],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: UNKNOWN");
    expect(result.stdout).not.toContain("problem");
  });

  it("reports problems as data with exit 0", () => {
    const result = run(["wf", "lint", "bad.yaml"], {
      responses: [
        ...KUBE_DEFAULTS,
        {
          match: ["lint", "bad.yaml"],
          stdout:
            'bad.yaml: in "hello" (Workflow): spec.entrypoint is required\n',
          exit: 1,
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lint: 1 problem found");
    expect(result.stdout).toContain("spec.entrypoint is required");
    expect(writeCalls(result)).toEqual([]);
  });

  it("counts secrets masked in lint problems", () => {
    const result = run(["wf", "lint", "bad.yaml"], {
      responses: [
        ...KUBE_DEFAULTS,
        {
          match: ["lint", "bad.yaml"],
          stdout: "bad.yaml: invalid value token=abc123\n",
          exit: 1,
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("abc123");
    expect(result.stdout).toContain("redacted: 1 sensitive values hidden");
  });

  it("reports auth and connection failures as errors, not lint problems", () => {
    for (const [stderr, code] of [
      [
        "error: You must be logged in to the server (Unauthorized)\n",
        "AUTH_REQUIRED",
      ],
      [
        "dial tcp 127.0.0.1:6443: connect: connection refused\n",
        "SERVER_UNREACHABLE",
      ],
    ]) {
      for (const cmd of [
        ["wf", "lint"],
        ["template", "lint"],
      ]) {
        const result = run([...cmd, "x.yaml"], {
          responses: [
            ...KUBE_DEFAULTS,
            { match: ["lint", "x.yaml"], stderr, exit: 1 },
          ],
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain(`code: ${code}`);
        expect(result.stdout).not.toContain("problem found");
      }
    }
  });

  it("lints stdin through a private temp file", () => {
    const result = run(["wf", "lint", "-"], {
      stdin: "apiVersion: argoproj.io/v1alpha1\nkind: Workflow\n",
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["lint"], stdout: "no linting errors found!\n" },
      ],
    });
    expect(result.stdout).toContain("lint: ok - 1 file valid");
    const lintCall = argoCalls(result).find((a) => a[0] === "lint");
    expect(lintCall?.[1]).toMatch(/argo-workflows-axi-.*stdin\.yaml$/);
  });
});
