import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const ALLOW = { writableTargets: [{ context: "kind-dev", namespace: "argo" }] };
const EXPLICIT = ["--context", "kind-dev", "-n", "argo"];

const READS: FakeResponse[] = [
  ...KUBE_DEFAULTS,
  { match: ["get", "ingest-q9w8e"], stdout: json(d.runningIngest()) },
  { match: ["get", "report-zz1"], stdout: json(d.succeededReport()) },
  { match: ["get", "nightly-etl-x7k2p"], stdout: json(d.failedEtl()) },
];

describe("write gate", () => {
  it("previews by default: no write reaches argo and the exact run command is printed", () => {
    const result = run(["wf", "stop", "ingest-q9w8e", "report-zz1"], {
      responses: READS,
      config: ALLOW,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry_run: true");
    expect(result.stdout).toContain(
      "ingest-q9w8e,Running,stop (exit handlers run)",
    );
    expect(result.stdout).toContain(
      "report-zz1,Succeeded,no-op (already_completed)",
    );
    expect(result.stdout).toContain(
      "run: argo-workflows-axi wf stop ingest-q9w8e report-zz1 --context kind-dev -n argo --apply",
    );
    expect(writeCalls(result)).toEqual([]);
  });

  it("says so in the preview when the target is not in the allowlist (default: none)", () => {
    const result = run(["wf", "suspend", "ingest-q9w8e"], { responses: READS });
    expect(result.stdout).toContain(
      "writable: no - this target is not in ~/.config/argo-workflows-axi/config.json",
    );
    expect(result.stdout).toContain(
      "`run` will be refused until a human adds this target",
    );
    expect(writeCalls(result)).toEqual([]);
  });

  it("--apply without an explicit target is a usage error and nothing is sent", () => {
    const result = run(["wf", "stop", "ingest-q9w8e", "--apply"], {
      responses: READS,
      config: ALLOW,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(
      "--apply needs an explicit target: missing -n/--namespace, --context",
    );
    expect(result.stdout).toContain("--context kind-dev -n argo --apply");
    expect(argoCalls(result)).toEqual([]);
  });

  it("rejects empty target flag values before anything runs", () => {
    for (const flags of [
      ["--argo-server="],
      ["-s", ""],
      ["--context="],
      ["-n", ""],
    ]) {
      const result = run(
        ["wf", "stop", "ingest-q9w8e", ...EXPLICIT, ...flags, "--apply"],
        {
          responses: READS,
          config: ALLOW,
          env: { ARGO_SERVER: "prod-argo:2746" },
        },
      );
      expect(result.exitCode, flags.join(" ")).toBe(2);
      expect(result.stdout, flags.join(" ")).toContain(
        "requires a non-empty value",
      );
      expect(result.calls, flags.join(" ")).toEqual([]);
    }
  });

  it("never hands argo a blank ARGO_SERVER in Kubernetes-API mode", () => {
    const result = run(["wf", "get", "ingest-q9w8e"], {
      responses: READS,
      env: { ARGO_SERVER: " " },
    });
    expect(result.exitCode).toBe(0);
    const calls = result.calls.filter((c) => c.bin === "argo");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.argoServerEnv === null)).toBe(true);
  });

  it("--apply on a target outside the allowlist is REFUSED and nothing is sent", () => {
    const result = run(["wf", "stop", "ingest-q9w8e", ...EXPLICIT, "--apply"], {
      responses: READS,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: REFUSED");
    expect(result.stdout).toContain(
      'Ask the user to add {"context":"kind-dev","namespace":"argo"}',
    );
    expect(argoCalls(result)).toEqual([]);
  });

  it("allowlist entries match context and namespace exactly (or namespace *)", () => {
    const other = run(
      [
        "wf",
        "stop",
        "ingest-q9w8e",
        "--context",
        "kind-dev",
        "-n",
        "prod",
        "--apply",
      ],
      {
        responses: READS,
        config: ALLOW,
      },
    );
    expect(other.stdout).toContain("code: REFUSED");
    const star = run(
      [
        "wf",
        "stop",
        "ingest-q9w8e",
        "--context",
        "kind-dev",
        "-n",
        "prod",
        "--apply",
      ],
      {
        responses: [...READS, { match: ["stop"], stdout: "" }],
        config: { writableTargets: [{ context: "kind-dev", namespace: "*" }] },
      },
    );
    expect(star.exitCode).toBe(0);
    expect(writeCalls(star)).toEqual([
      [
        "stop",
        "ingest-q9w8e",
        "--context=kind-dev",
        "--namespace=prod",
        "--loglevel=error",
      ],
    ]);
  });

  it("--apply on an allowlisted, explicit target runs the write and reports per-object results", () => {
    const result = run(
      [
        "wf",
        "stop",
        "ingest-q9w8e",
        "report-zz1",
        "--message",
        "bad input",
        ...EXPLICIT,
        "--apply",
      ],
      {
        responses: [
          ...READS,
          {
            match: ["stop", "ingest-q9w8e"],
            stdout: "workflow ingest-q9w8e stopped\n",
          },
        ],
        config: ALLOW,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ingest-q9w8e,stop_requested,Running");
    expect(result.stdout).toContain("report-zz1,already_completed,Succeeded");
    expect(result.stdout).toContain(
      "target: kubernetes context=kind-dev namespace=argo",
    );
    // The completed workflow is an idempotent no-op: only one write is sent.
    expect(writeCalls(result)).toEqual([
      [
        "stop",
        "ingest-q9w8e",
        "--message=bad input",
        "--context=kind-dev",
        "--namespace=argo",
        "--loglevel=error",
      ],
    ]);
  });

  it("rejects -A on writes, even for a preview", () => {
    const result = run(["wf", "retry", "nightly-etl-x7k2p", "-A"], {
      responses: READS,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Writes never accept -A/--all-namespaces");
    expect(argoCalls(result)).toEqual([]);
  });

  it("caps names at 20 per call and rejects duplicates", () => {
    const names = Array.from({ length: 21 }, (_, i) => `wf-${i}`);
    const many = run(["wf", "suspend", ...names]);
    expect(many.exitCode).toBe(2);
    expect(many.stdout).toContain("At most 20 names per call (got 21)");
    const dup = run(["wf", "suspend", "a", "a"]);
    expect(dup.exitCode).toBe(2);
    expect(dup.stdout).toContain("more than once");
  });

  it("does not let ARGO_SERVER silently redirect a write aimed at a kube context", () => {
    const result = run(["wf", "stop", "ingest-q9w8e", ...EXPLICIT, "--apply"], {
      responses: READS,
      config: ALLOW,
      env: { ARGO_SERVER: "argo.example.internal:2746" },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(
      "--argo-server (ARGO_SERVER is set, so argo talks to that server)",
    );
    expect(writeCalls(result)).toEqual([]);
  });

  it("works against an allowlisted Argo Server with --argo-server", () => {
    const result = run(
      [
        "wf",
        "suspend",
        "ingest-q9w8e",
        "--argo-server",
        "argo.example.internal:2746",
        "-n",
        "argo",
        "--apply",
      ],
      {
        responses: [...READS, { match: ["suspend"], stdout: "" }],
        config: {
          writableTargets: [
            { server: "argo.example.internal:2746", namespace: "argo" },
          ],
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ingest-q9w8e,suspended,Running");
    expect(writeCalls(result)[0]).toContain(
      "--argo-server=argo.example.internal:2746",
    );
  });

  it("reports a failed write with exit 1 while still listing every result", () => {
    const result = run(
      [
        "wf",
        "terminate",
        "ingest-q9w8e",
        "nightly-etl-x7k2p",
        ...EXPLICIT,
        "--apply",
      ],
      {
        responses: [
          ...READS,
          {
            match: ["terminate", "ingest-q9w8e"],
            stderr:
              "Error: rpc error: code = PermissionDenied desc = workflows.argoproj.io is forbidden\n",
            exit: 1,
          },
        ],
        config: ALLOW,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "error: 1 of 2 terminate operations failed",
    );
    expect(result.stdout).toContain("code: WRITE_FAILED");
    expect(result.stdout).toContain(
      'ingest-q9w8e,"failed - FORBIDDEN: Permission denied',
    );
    expect(result.stdout).toContain(
      "nightly-etl-x7k2p,already_completed,Failed",
    );
  });
});

describe("idempotent resubmit", () => {
  const source = d.failedEtl();
  const uid = source.metadata.uid as string;
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 20);
  const resultName = `nightly-etl-x7k2p-rs-${hash(`${uid}:0`)}`;
  const createdWorkflow = (generation = "0", key = hash(`${uid}:0`)) => ({
    metadata: {
      name: resultName,
      namespace: "argo",
      uid: "copy-uid",
      labels: {
        "axi.argoproj.io/resubmit-source": hash(uid),
        "axi.argoproj.io/resubmit-key": key,
        "axi.argoproj.io/resubmit-generation": generation,
      },
    },
    spec: source.spec,
    status: { phase: "Running" },
  });
  const begin = [
    ...KUBE_DEFAULTS,
    { match: ["get", "nightly-etl-x7k2p"], stdout: json(source) },
  ];
  const miss = {
    match: ["get", resultName],
    stderr: "Error: rpc error: code = NotFound desc = workflow not found\\n",
    exit: 1,
  };
  const prior = { match: ["list"], stdout: "[]" };
  const runArgs = (args: string[]) => [
    "wf",
    "resubmit",
    "nightly-etl-x7k2p",
    ...EXPLICIT,
    ...args,
    "--apply",
  ];

  it("creates with a stable name and idempotency label; retry reuses it", () => {
    const first = run(runArgs([]), {
      responses: [...begin, prior, miss, { match: ["submit"], stdout: "{}" }],
      config: ALLOW,
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(`created ${resultName}`);
    const submit = first.calls.find((call) => call.argv[0] === "submit");
    expect(submit?.argv).toContain(`--name=${resultName}`);
    expect(submit?.files).toBeDefined();
    expect(Object.values(submit?.files ?? {}).join("\\n")).toContain(
      `name: ${resultName}`,
    );
    expect(Object.values(submit?.files ?? {}).join("\\n")).toContain(
      `axi.argoproj.io/resubmit-key: ${hash(`${uid}:0`)}`,
    );

    const retry = run(runArgs([]), {
      responses: [
        ...begin,
        prior,
        { match: ["get", resultName], stdout: json(createdWorkflow()) },
      ],
      config: ALLOW,
    });
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toContain(`reused existing ${resultName}`);
    expect(writeCalls(retry)).toEqual([]);

    const unrelated = (workflow: ReturnType<typeof createdWorkflow>) => ({
      ...workflow,
      metadata: {
        ...workflow.metadata,
        labels: {
          ...workflow.metadata.labels,
          "axi.argoproj.io/resubmit-source": "other-source",
        },
      },
    });
    const nameTaken = run(runArgs([]), {
      responses: [
        ...begin,
        prior,
        {
          match: ["get", resultName],
          stdout: json(unrelated(createdWorkflow())),
        },
      ],
      config: ALLOW,
    });
    expect(nameTaken.exitCode).toBe(1);
    expect(nameTaken.stdout).toContain("is taken by an unrelated workflow");

    const createRace = run(runArgs([]), {
      responses: [
        ...begin,
        {
          match: ["get", resultName],
          stderr:
            "Error: rpc error: code = NotFound desc = workflow not found\\n",
          exit: 1,
          times: 1,
        },
        {
          match: ["submit"],
          stderr:
            "Error: rpc error: code = AlreadyExists desc = workflows already exists\\n",
          exit: 1,
        },
        { match: ["get", resultName], stdout: json(createdWorkflow()) },
      ],
      config: ALLOW,
    });
    expect(createRace.exitCode).toBe(0);
    expect(createRace.stdout).toContain(`reused existing ${resultName}`);

    const unrelatedRace = run(runArgs([]), {
      responses: [
        ...begin,
        {
          match: ["get", resultName],
          stderr:
            "Error: rpc error: code = NotFound desc = workflow not found\\n",
          exit: 1,
          times: 1,
        },
        {
          match: ["submit"],
          stderr:
            "Error: rpc error: code = AlreadyExists desc = workflows already exists\\n",
          exit: 1,
        },
        {
          match: ["get", resultName],
          stdout: json(unrelated(createdWorkflow())),
        },
      ],
      config: ALLOW,
    });
    expect(unrelatedRace.exitCode).toBe(1);
    expect(unrelatedRace.stdout).toContain("is taken by an unrelated workflow");
  });

  it("requires --new for native memoized resubmit", () => {
    const unsafe = run(runArgs(["--memoized"]), {
      responses: begin,
      config: ALLOW,
    });
    expect(unsafe.exitCode).toBe(2);
    expect(unsafe.stdout).toContain("--memoized requires --new");
    expect(argoCalls(unsafe)).toEqual([]);

    const deliberate = run(
      runArgs(["--memoized", "--new", "--priority", "5"]),
      {
        responses: [
          ...begin,
          { match: ["resubmit"], stdout: json(createdWorkflow()) },
          { bin: "kubectl", match: ["patch", "workflow"], stdout: "" },
        ],
        config: ALLOW,
      },
    );
    expect(deliberate.exitCode).toBe(0);
    expect(writeCalls(deliberate)[0]).toEqual([
      "resubmit",
      "nightly-etl-x7k2p",
      "--memoized",
      "--priority=5",
      "--output=json",
      "--context=kind-dev",
      "--namespace=argo",
      "--loglevel=error",
    ]);
    expect(deliberate.stdout).toContain("memoized; not retry-safe");
  });

  it("uses --key and --new to choose deterministic generations", () => {
    const custom = run(runArgs(["--key", "customer-run"]), {
      responses: [
        ...begin,
        prior,
        {
          match: ["get"],
          stderr:
            "Error: rpc error: code = NotFound desc = workflow not found\\n",
          exit: 1,
        },
        { match: ["submit"] },
      ],
      config: ALLOW,
    });
    const customName = `nightly-etl-x7k2p-rs-${hash("customer-run")}`;
    expect(custom.stdout).toContain(`created ${customName}`);
    expect(
      custom.calls.find((call) => call.argv[0] === "submit")?.argv,
    ).toContain(`--name=${customName}`);
    const customRetry = run(runArgs(["--key", "customer-run"]), {
      responses: [
        ...begin,
        {
          match: ["get", customName],
          stdout: json(createdWorkflow("0", hash("customer-run"))),
        },
      ],
      config: ALLOW,
    });
    expect(customRetry.stdout).toContain(`reused existing ${customName}`);
    expect(writeCalls(customRetry)).toEqual([]);

    const next = run(runArgs(["--new"]), {
      responses: [
        ...begin,
        {
          match: ["list"],
          stdout: json([
            createdWorkflow("0"),
            createdWorkflow("not-a-number"),
            createdWorkflow(""),
            createdWorkflow("1e3"),
            createdWorkflow("0x10"),
            createdWorkflow("9007199254740992"),
          ]),
        },
        {
          match: ["get"],
          stderr:
            "Error: rpc error: code = NotFound desc = workflow not found\\n",
          exit: 1,
        },
        { match: ["submit"] },
      ],
      config: ALLOW,
    });
    const nextName = `nightly-etl-x7k2p-rs-${hash(`${uid}:1`)}`;
    expect(next.stdout).toContain(`created ${nextName}`);
    expect(
      next.calls.find((call) => call.argv[0] === "submit")?.argv,
    ).toContain(`--name=${nextName}`);
  });
});

describe("idempotent no-ops (S15)", () => {
  it.each([
    [["wf", "suspend", "report-zz1"], "no-op (already_completed)"],
    [["wf", "resume", "ingest-q9w8e"], "no-op (not_suspended)"],
    [["wf", "retry", "ingest-q9w8e"], "no-op (already_running)"],
    [["wf", "retry", "report-zz1"], "no-op (nothing_to_retry)"],
    [["wf", "terminate", "nightly-etl-x7k2p"], "no-op (already_completed)"],
  ])("%j", (args, text) => {
    const result = run(args, { responses: READS, config: ALLOW });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(text);
    expect(result.stdout).toContain("result: nothing to do");
    expect(result.stdout).not.toContain("\nrun:");
  });

  it("already-suspended and stopping workflows are no-ops", () => {
    const suspended = run(["wf", "suspend", "ingest-q9w8e"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get"], stdout: json(d.runningIngest({ suspend: true })) },
      ],
    });
    expect(suspended.stdout).toContain("no-op (already_suspended)");
    const stopping = run(["wf", "stop", "ingest-q9w8e"], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["get"], stdout: json(d.runningIngest({ shutdown: "Stop" })) },
      ],
    });
    expect(stopping.stdout).toContain("no-op (already_shutting_down (Stop))");
  });

  it("retry of a failed workflow forwards argo's own flags", () => {
    const result = run(
      [
        "wf",
        "retry",
        "nightly-etl-x7k2p",
        "--node-field-selector",
        "displayName=load-warehouse",
        "-p",
        "date=2026-10-29",
        ...EXPLICIT,
        "--apply",
      ],
      {
        responses: [...READS, { match: ["retry"], stdout: "{}" }],
        config: ALLOW,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(writeCalls(result)).toEqual([
      [
        "retry",
        "nightly-etl-x7k2p",
        "--node-field-selector=displayName=load-warehouse",
        "--parameter=date=2026-10-29",
        "--context=kind-dev",
        "--namespace=argo",
        "--loglevel=error",
      ],
    ]);
  });

  it("memoized resubmit of a non-failed workflow is blocked in the preview", () => {
    const result = run(["wf", "resubmit", "report-zz1", "--memoized"], {
      responses: READS,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--memoized requires --new");
  });
});

describe("cron suspend/resume", () => {
  const CRON_READS: FakeResponse[] = [
    ...KUBE_DEFAULTS,
    {
      match: ["cron", "get", "nightly-etl"],
      stdout: json(d.cron("nightly-etl", false)),
    },
    {
      match: ["cron", "get", "weekly-cleanup"],
      stdout: json(d.cron("weekly-cleanup", true)),
    },
  ];

  it("previews and reports idempotent no-ops", () => {
    const result = run(["cron", "suspend", "nightly-etl", "weekly-cleanup"], {
      responses: CRON_READS,
    });
    expect(result.stdout).toContain("cron_workflows[2]{name,phase,change}:");
    expect(result.stdout).toContain("nightly-etl,active,suspend schedule");
    expect(result.stdout).toContain(
      "weekly-cleanup,suspended,no-op (already_suspended)",
    );
    expect(writeCalls(result)).toEqual([]);
  });

  it("applies cron resume on an allowlisted target", () => {
    const result = run(
      ["cron", "resume", "weekly-cleanup", ...EXPLICIT, "--apply"],
      {
        responses: [...CRON_READS, { match: ["cron", "resume"], stdout: "" }],
        config: ALLOW,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("weekly-cleanup,resumed,suspended");
    expect(writeCalls(result)).toEqual([
      [
        "cron",
        "resume",
        "weekly-cleanup",
        "--context=kind-dev",
        "--namespace=argo",
        "--loglevel=error",
      ],
    ]);
  });
});

describe("wf submit", () => {
  const TEMPLATE_READS: FakeResponse[] = [
    ...KUBE_DEFAULTS,
    { match: ["template", "get", "nightly-etl"], stdout: json(d.template()) },
    {
      match: ["get", "etl-1028"],
      stderr:
        'level=fatal msg="rpc error: code = NotFound desc = workflows.argoproj.io \\"etl-1028\\" not found"\n',
      exit: 1,
    },
  ];

  it("previews --from with merged parameters (redacted) and blocks on missing required ones", () => {
    const result = run(
      [
        "wf",
        "submit",
        "--from",
        "workflowtemplate/nightly-etl",
        "-p",
        "region=us",
        "--name",
        "etl-1028",
      ],
      {
        responses: TEMPLATE_READS,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source: workflowtemplate/nightly-etl");
    expect(result.stdout).toContain('date,"",missing (required)');
    expect(result.stdout).toContain("region,us,given");
    expect(result.stdout).toContain('api-token,"[redacted]",default');
    expect(result.stdout).not.toContain("s3cr3t-default");
    expect(result.stdout).toContain(
      'blocked: "missing required parameters: date"',
    );
    expect(result.stdout).not.toContain("\nrun:");
    expect(writeCalls(result)).toEqual([]);
  });

  it("submits --from on --apply with argo's kind names and parameters", () => {
    const created = {
      ...d.runningIngest(),
      metadata: { name: "etl-1028", namespace: "argo" },
      status: { phase: "Pending" },
    };
    const result = run(
      [
        "wf",
        "submit",
        "--from",
        "workflowtemplate/nightly-etl",
        "-p",
        "date=2026-10-28",
        "--name",
        "etl-1028",
        ...EXPLICIT,
        "--apply",
      ],
      {
        responses: [
          ...TEMPLATE_READS,
          { match: ["submit"], stdout: json(created) },
        ],
        config: ALLOW,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("result: submitted");
    expect(result.stdout).toContain("name: etl-1028");
    expect(writeCalls(result)).toEqual([
      [
        "submit",
        "--from=workflowtemplate/nightly-etl",
        "--parameter=date=2026-10-28",
        "--name=etl-1028",
        "--output=json",
        "--context=kind-dev",
        "--namespace=argo",
        "--loglevel=error",
      ],
    ]);
  });

  it("is an idempotent no-op when --name already exists", () => {
    const result = run(
      [
        "wf",
        "submit",
        "--from",
        "cronwf/nightly-etl",
        "--name",
        "nightly-etl-x7k2p",
        ...EXPLICIT,
        "--apply",
      ],
      {
        responses: [
          ...READS,
          {
            match: ["cron", "get", "nightly-etl"],
            stdout: json(d.cron("nightly-etl", false)),
          },
        ],
        config: ALLOW,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("result: already_exists");
    expect(writeCalls(result)).toEqual([]);
  });

  it("previews a manifest file with lint as a preflight and warns it is not idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "awf-axi-spec-"));
    const file = join(dir, "hello.yaml");
    writeFileSync(
      file,
      "apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata:\n  generateName: hello-\nspec:\n  entrypoint: say\n  arguments:\n    parameters:\n      - name: message\n        value: hi\n",
    );
    const result = run(["wf", "submit", file], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["lint"], stdout: "no linting errors found!\n" },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source: manifest");
    expect(result.stdout).toContain("workflow: hello-<random>");
    expect(result.stdout).toContain("entrypoint: say");
    expect(result.stdout).toContain("not idempotent");
    expect(result.stdout).toContain(
      `run: argo-workflows-axi wf submit ${file} --context kind-dev -n argo --apply`,
    );
    expect(writeCalls(result)).toEqual([]);
  });

  it("rejects non-Workflow manifests and ambiguous sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "awf-axi-spec-"));
    const file = join(dir, "tmpl.yaml");
    writeFileSync(file, "kind: WorkflowTemplate\nmetadata:\n  name: x\n");
    const wrongKind = run(["wf", "submit", file], { responses: KUBE_DEFAULTS });
    expect(wrongKind.exitCode).toBe(2);
    expect(wrongKind.stdout).toContain("Expected kind Workflow");
    const both = run(["wf", "submit", file, "--from", "workflowtemplate/x"]);
    expect(both.exitCode).toBe(2);
    expect(both.stdout).toContain("Pass exactly one of a manifest file");
    for (const kind of ["pod", "template", "clustertemplate", "cron"]) {
      const badKind = run(["wf", "submit", "--from", `${kind}/x`]);
      expect(badKind.exitCode).toBe(2);
      expect(badKind.stdout).toContain("--from must be <kind>/<name>");
      expect(badKind.calls).toEqual([]);
    }
  });

  it("accepts argo's own spellings of the --from kinds", () => {
    const result = run(
      ["wf", "submit", "--from", "wftmpl/nightly-etl", "-p", "date=x"],
      { responses: TEMPLATE_READS },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source: workflowtemplate/nightly-etl");
  });

  it("blocks a manifest whose metadata.namespace differs from the target, in preview and on --apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "awf-axi-spec-"));
    const file = join(dir, "prod.yaml");
    writeFileSync(
      file,
      "apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata:\n  name: hello\n  namespace: prod\nspec:\n  entrypoint: say\n",
    );
    const responses: FakeResponse[] = [
      ...KUBE_DEFAULTS,
      { match: ["lint"], stdout: "no linting errors found!\n" },
      {
        match: ["get", "hello"],
        stderr: 'level=fatal msg="code = NotFound desc = not found"\n',
        exit: 1,
      },
      { match: ["submit"], stdout: json({ metadata: { name: "hello" } }) },
    ];
    const preview = run(["wf", "submit", file], { responses, config: ALLOW });
    expect(preview.exitCode).toBe(2);
    expect(preview.stdout).toContain("metadata.namespace prod");
    const applied = run(["wf", "submit", file, ...EXPLICIT, "--apply"], {
      responses,
      config: ALLOW,
    });
    expect(applied.exitCode).toBe(2);
    expect(applied.stdout).toContain("code: VALIDATION_ERROR");
    expect(writeCalls(applied)).toEqual([]);
  });

  const SUBMIT_OK: FakeResponse[] = [
    ...KUBE_DEFAULTS,
    { match: ["lint"], stdout: "no linting errors found!\n" },
    {
      match: ["get", "hello"],
      stderr: 'level=fatal msg="code = NotFound desc = not found"\n',
      exit: 1,
    },
    { match: ["submit"], stdout: json({ metadata: { name: "hello" } }) },
  ];

  function specFile(name: string, text: string): string {
    const file = join(mkdtempSync(join(tmpdir(), "awf-axi-spec-")), name);
    writeFileSync(file, text);
    return file;
  }

  it("blocks YAML indirection in the top level or metadata, in preview and on --apply", () => {
    const manifests = {
      "merge key namespace":
        "apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nx: &ns\n  namespace: prod\nmetadata:\n  <<: *ns\n  name: hello\nspec:\n  entrypoint: say\n",
      "top-level merge key":
        "kind: Workflow\nx: &m\n  metadata:\n    namespace: prod\n<<: *m\nspec:\n  entrypoint: say\n",
      "alias in metadata":
        "kind: Workflow\nx: &ns prod\nmetadata:\n  name: hello\n  namespace: *ns\nspec:\n  entrypoint: say\n",
      "alias for metadata":
        "kind: Workflow\nx: &m\n  namespace: prod\nmetadata: *m\nspec:\n  entrypoint: say\n",
      "tag in metadata":
        "kind: Workflow\nmetadata:\n  name: hello\n  namespace: !!str prod\nspec:\n  entrypoint: say\n",
      "non-string namespace":
        "kind: Workflow\nmetadata:\n  name: hello\n  namespace: 2024-01-01\nspec:\n  entrypoint: say\n",
    };
    for (const [label, text] of Object.entries(manifests)) {
      const file = specFile("indirect.yaml", text);
      for (const extra of [[], [...EXPLICIT, "--apply"]]) {
        const result = run(["wf", "submit", file, ...extra], {
          responses: SUBMIT_OK,
          config: ALLOW,
        });
        expect(result.exitCode, label).toBe(2);
        expect(result.stdout, label).toContain("code: VALIDATION_ERROR");
        expect(argoCalls(result), label).toEqual([]);
      }
    }
  });

  it("rejects manifests the YAML parser reports problems for", () => {
    const file = specFile(
      "dup.yaml",
      "kind: Workflow\nmetadata:\n  name: hello\n  namespace: argo\n  namespace: prod\n",
    );
    const result = run(["wf", "submit", file], { responses: KUBE_DEFAULTS });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("not valid YAML");
    expect(argoCalls(result)).toEqual([]);
  });

  const PASSTHROUGH =
    "apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata:\n  name: hello\n  namespace: argo\nx: &defaults\n  mode: 0755\nspec:\n  entrypoint: say\n  arguments:\n    artifacts:\n      - name: script\n        <<: *defaults\n    parameters:\n      - name: run-date\n        value: 2024-01-01\n      - name: at\n        value: 12:30\n      - name: flag\n        value: yes\n";

  function argoInputs(result: ReturnType<typeof run>): string[] {
    return ["lint", "submit"].map((verb) => {
      const call = result.calls.find(
        (c) => c.bin === "argo" && c.argv[0] === verb,
      );
      const path = call?.argv[1] ?? "";
      expect(path).toMatch(/argo-workflows-axi-.*manifest\.yaml$/);
      return call?.files[path] ?? "";
    });
  }

  it("lints and submits a private copy of the checked bytes, never the user's path", () => {
    const file = specFile("passthrough.yaml", PASSTHROUGH);
    const changed = PASSTHROUGH.replace("namespace: argo", "namespace: prod");
    const result = run(["wf", "submit", file, ...EXPLICIT, "--apply"], {
      responses: [
        { ...SUBMIT_OK[2], writeFile: [file, changed] },
        ...SUBMIT_OK,
      ],
      config: ALLOW,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("result: submitted");
    expect(readFileSync(file, "utf-8")).toBe(changed);
    expect(argoInputs(result)).toEqual([PASSTHROUGH, PASSTHROUGH]);
  });

  it("reads stdin and /dev/fd-style paths once, in preview and on --apply", () => {
    for (const source of ["-", "/dev/stdin", "/dev/fd/0"]) {
      const preview = run(["wf", "submit", source], {
        stdin: PASSTHROUGH,
        responses: SUBMIT_OK,
        config: ALLOW,
      });
      expect(preview.exitCode, source).toBe(0);
      expect(preview.stdout, source).toContain("dry_run: true");
      expect(preview.stdout, source).toContain("workflow: hello");
      const applied = run(["wf", "submit", source, ...EXPLICIT, "--apply"], {
        stdin: PASSTHROUGH,
        responses: SUBMIT_OK,
        config: ALLOW,
      });
      expect(applied.exitCode, source).toBe(0);
      expect(applied.stdout, source).toContain("result: submitted");
      expect(argoInputs(applied)).toEqual([PASSTHROUGH, PASSTHROUGH]);
    }
  });
});
