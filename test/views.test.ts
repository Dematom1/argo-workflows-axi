import { describe, expect, it } from "vitest";
import * as d from "./fixtures/data.js";
import {
  CTX_BIN,
  KUBE_DEFAULTS,
  argoCalls,
  json,
  run,
  type FakeResponse,
} from "./helpers.js";

const VERSION_OK: FakeResponse = {
  match: ["version", "--short"],
  stdout: "argo: v4.1.6\n",
};
const WORKFLOWS = [
  d.succeededReport(),
  d.failedEtl(),
  d.runningIngest(),
  d.oomTrain(),
  d.stuckPending(),
];
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

describe("home view", () => {
  it("shows the target, a phase tally, failed and running workflows first, and the cron summary", () => {
    const result = run([], {
      responses: [
        ...KUBE_DEFAULTS,
        VERSION_OK,
        { match: ["list", "--output=json"], stdout: json(WORKFLOWS) },
        ...CRONS,
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^bin: /);
    expect(result.stdout).toContain(
      "description: Inspect and operate Argo Workflows",
    );
    expect(result.stdout).toContain(
      "target: kubernetes context=kind-dev namespace=argo",
    );
    expect(result.stdout).toContain(
      'workflows: "5 total (Failed 1, Error 1, Running 1, Pending 1, Succeeded 1)"',
    );
    expect(result.stdout).toContain("failed[2]{name,phase,finished,message}:");
    expect(result.stdout).toContain("running[2]{name,phase,age,progress}:");
    expect(result.stdout).toContain("cron: 2 cron workflows (1 suspended)");
    expect(result.stdout).toContain(
      "help[4]:\n  Run `argo-workflows-axi triage`",
    );
    // A supported argo version is not worth a line in the home view.
    expect(result.stdout).not.toContain("argo:");
  });

  it("degrades each sub-call to `unavailable - reason` with exit 0", () => {
    const result = run([], {
      responses: [
        ...KUBE_DEFAULTS,
        VERSION_OK,
        {
          match: ["cron", "list"],
          stderr:
            "Error: rpc error: code = PermissionDenied desc = forbidden\n",
          exit: 1,
        },
        {
          match: ["list"],
          stderr:
            'time="2026-10-28T10:00:00Z" level=fatal msg="dial tcp 10.0.0.1:443: connect: connection refused"\n',
          exit: 1,
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'workflows: "unavailable - Cannot reach the cluster or Argo Server: dial tcp',
    );
    expect(result.stdout).toContain(
      'cron: "unavailable - Permission denied: forbidden"',
    );
    expect(result.stdout).toContain(
      "Run `argo-workflows-axi ctx` to check which context or server is targeted",
    );
  });

  it("states an empty namespace definitively", () => {
    const result = run([], {
      responses: [
        ...KUBE_DEFAULTS,
        VERSION_OK,
        { match: ["list", "--output=json"], stdout: "[]\n" },
        { match: ["cron", "list", "--output=name"], stdout: "" },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("workflows: 0 workflows in namespace argo");
    expect(result.stdout).toContain("cron: 0 cron workflows");
  });

  it("warns when the argo CLI is outside the supported range", () => {
    const result = run([], {
      responses: [
        ...KUBE_DEFAULTS,
        { match: ["version", "--short"], stdout: "argo: v3.4.18\n" },
        { match: ["list", "--output=json"], stdout: "[]\n" },
        { match: ["cron", "list"], stdout: "" },
      ],
    });
    expect(result.stdout).toContain(
      "argo: v3.4.18 - outside the supported range (v3.7 through v4.1)",
    );
  });
});

describe("ctx (offline)", () => {
  it("resolves context and namespace from kubeconfig without calling the cluster", () => {
    const result = run(["ctx"], { responses: [...KUBE_DEFAULTS, VERSION_OK] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "target: kubernetes context=kind-dev namespace=argo",
    );
    expect(result.stdout).toContain("namespace: argo (from kubeconfig)");
    expect(result.stdout).toContain("argo: v4.1.6 - supported");
    expect(result.stdout).toContain(
      "writable: no - not in ~/.config/argo-workflows-axi/config.json",
    );
    expect(result.stdout).toContain("writable_targets: 0");
    // Only the local version call reaches argo.
    expect(argoCalls(result)).toEqual([
      ["version", "--short", "--loglevel=error"],
    ]);
  });

  it("keeps the version call offline even when ARGO_SERVER is set", () => {
    const result = run(["ctx"], {
      responses: [VERSION_OK],
      env: {
        ARGO_SERVER: "argo.example.internal:2746",
        ARGO_NAMESPACE: "pipelines",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'target: "argo-server server=argo.example.internal:2746 namespace=pipelines"',
    );
    expect(result.stdout).toContain(
      "namespace: pipelines (from ARGO_NAMESPACE)",
    );
    expect(result.stdout).toContain("archive: available (Argo Server mode)");
    const versionCall = result.calls.find(
      (c) => c.bin === "argo" && c.argv[0] === "version",
    );
    expect(versionCall?.argoServerEnv).toBeNull();
  });

  it("reports writable targets from the local allowlist", () => {
    const result = run(["ctx", "-n", "argo"], {
      responses: [...KUBE_DEFAULTS, VERSION_OK],
      config: {
        writableTargets: [
          { context: "kind-dev", namespace: "argo" },
          { server: "x:2746", namespace: "*" },
        ],
      },
    });
    expect(result.stdout).toContain("writable: yes");
    expect(result.stdout).toContain("writable_targets: 2");
  });

  it("reports an invalid allowlist file instead of failing", () => {
    const result = run(["ctx"], {
      responses: [...KUBE_DEFAULTS, VERSION_OK],
      config: "{not json",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'writable: "no - Invalid config ~/.config/argo-workflows-axi/config.json: not valid JSON',
    );
  });

  it("degrades when kubectl and argo are missing", () => {
    const result = run(["ctx"], { noKubectl: true, responses: [] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "context: unavailable - kubectl is not installed",
    );
  });

  it("the hook binary prints the same offline view under the tool's name", () => {
    const result = run([], {
      bin: CTX_BIN,
      responses: [...KUBE_DEFAULTS, VERSION_OK],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^tool: argo-workflows-axi \(offline context\)\ntarget: kubernetes context=kind-dev namespace=argo\n/,
    );
    expect(argoCalls(result)).toEqual([
      ["version", "--short", "--loglevel=error"],
    ]);
  });
});

describe("archive", () => {
  it("answers UNSUPPORTED_IN_MODE in Kubernetes-API mode without calling argo", () => {
    const result = run(["archive", "list"], { responses: KUBE_DEFAULTS });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: UNSUPPORTED_IN_MODE");
    expect(argoCalls(result)).toEqual([]);
  });

  it("lists archived workflows in Argo Server mode", () => {
    const result = run(
      [
        "archive",
        "list",
        "--argo-server",
        "argo.example.internal:2746",
        "-n",
        "argo",
      ],
      {
        responses: [
          {
            match: ["archive", "list", "--output=json"],
            stdout: json([d.failedEtl(), d.succeededReport()]),
          },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("count: 2 of 2 total in namespace argo");
    expect(result.stdout).toContain(
      "archived_workflows[2]{name,phase,finished,uid}:",
    );
    expect(argoCalls(result)[0]).toContain(
      "--argo-server=argo.example.internal:2746",
    );
  });
});

describe("archive get", () => {
  it("resolves the name to the newest archived run's UID (argo v3.7-v4.0 take only a UID)", () => {
    const server = [
      "--argo-server",
      "argo.example.internal:2746",
      "-n",
      "argo",
    ];
    const older = d.failedEtl() as {
      metadata: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    older.metadata.uid = "00000000-0000-4000-8000-000000000000";
    older.status.finishedAt = d.ago(9 * 86400);
    const result = run(["archive", "get", "nightly-etl-x7k2p", ...server], {
      responses: [
        {
          match: ["archive", "list", "--output=json"],
          stdout: json([older, d.failedEtl(), d.succeededReport()]),
        },
        {
          match: ["archive", "get", "11111111-2222-4333-8444-555555555555"],
          stdout: json(d.failedEtl()),
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nightly-etl-x7k2p");
    expect(result.stdout).toContain(
      "2 archived runs are named nightly-etl-x7k2p; showing the newest (uid 11111111-2222-4333-8444-555555555555)",
    );
    const getCall = argoCalls(result).find((a) => a[1] === "get");
    expect(getCall).toEqual([
      "archive",
      "get",
      "11111111-2222-4333-8444-555555555555",
      "--output=json",
      "--argo-server=argo.example.internal:2746",
      "--namespace=argo",
      "--loglevel=error",
    ]);
    const long = d.failedEtl() as {
      spec: {
        arguments: { parameters: Array<{ name: string; value: string }> };
      };
    };
    long.spec.arguments.parameters.push({
      name: "payload",
      value: "z".repeat(800),
    });
    const truncated = run(["archive", "get", "nightly-etl-x7k2p", ...server], {
      responses: [
        { match: ["archive", "list"], stdout: json([d.failedEtl()]) },
        { match: ["archive", "get"], stdout: json(long) },
      ],
    });
    expect(truncated.stdout).toContain(
      "Ask a human to run `argo archive get 11111111-2222-4333-8444-555555555555 -o json --argo-server argo.example.internal:2746 -n argo`",
    );
    const missing = run(["archive", "get", "ghost", ...server], {
      responses: [{ match: ["archive", "list"], stdout: "[]" }],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: NOT_FOUND");
    const byUid = run([
      "archive",
      "get",
      "11111111-2222-4333-8444-555555555555",
      "--uid",
      ...server,
    ]);
    expect(byUid.exitCode).toBe(2);
    expect(byUid.stdout).toContain("Unknown flag --uid");
    expect(byUid.calls).toEqual([]);
  });
});

describe("setup hooks", () => {
  it("installs a SessionStart hook that runs the offline ctx binary, idempotently", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const first = run(["setup", "hooks"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(
      "setup: hooks installed or already up to date",
    );
    expect(first.stdout).toContain(
      "runs: argo-workflows-axi-ctx (offline - no network or credentials)",
    );
    const settings = readFileSync(
      join(first.home, ".claude", "settings.json"),
      "utf-8",
    );
    expect(settings).toContain("argo-workflows-axi-ctx.js");
    expect(settings).toContain("SessionStart");
    expect(first.calls).toEqual([]);
  });

  it("installs user-scope hooks only: --project and --status are not flags", () => {
    for (const flag of ["--project", "--status"]) {
      const result = run(["setup", "hooks", flag]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain(`Unknown flag ${flag}`);
    }
  });
});
