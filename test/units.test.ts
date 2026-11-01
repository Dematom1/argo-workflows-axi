import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { shellQuote } from "../src/format.js";
import { isApprovalFor, mintApproval } from "../src/approval.js";
import { extractDetail, mapArgoFailure } from "../src/errors.js";
import { checkWrite } from "../src/gate.js";
import { redactText, redactValue } from "../src/redact.js";
import { OPERATIONS, REFUSALS } from "../src/registry.js";
import { parseJsonStream, runRead, runWrite } from "../src/seam.js";
import type { Target } from "../src/target.js";
import { podNameOf, type Workflow } from "../src/workflow.js";
import * as d from "./fixtures/data.js";
import { KUBE_DEFAULTS, json, run } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");

function registeredOperation(bin: string, argv: string[]): string | undefined {
  return Object.entries(OPERATIONS).find(
    ([, op]) =>
      op.bin === bin &&
      op.command.every((token, i) => argv[i] === token) &&
      argv
        .slice(op.command.length)
        .filter((arg) => arg.startsWith("-"))
        .every((arg) => {
          const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
          return (
            (op.flags as readonly string[]).includes(name) ||
            (op.targeted &&
              ["--context", "--argo-server", "--namespace"].includes(name)) ||
            (op.bin === "argo" && name === "--loglevel")
          );
        }),
  )?.[0];
}

describe("read-only by construction (S5)", () => {
  it("every process the CLI starts is a registered operation", () => {
    const dir = mkdtempSync(join(tmpdir(), "awf-axi-sweep-"));
    const manifest = join(dir, "wf.yaml");
    writeFileSync(
      manifest,
      "apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata:\n  name: hello\nspec:\n  entrypoint: say\n",
    );
    const responses = [
      ...KUBE_DEFAULTS,
      { match: ["version"], stdout: "argo: v3.7.0\n" },
      { match: ["cron", "list"], stdout: "" },
      { match: ["template", "list"], stdout: "[]" },
      { match: ["cluster-template", "list"], stdout: "[]" },
      { match: ["template", "get"], stdout: json(d.template()) },
      { match: ["cron", "get"], stdout: json(d.cron("nightly-etl", true)) },
      { match: ["lint"], stdout: "no linting errors found!\n" },
      { match: ["logs"], stdout: "line\n" },
      { match: ["get", "@latest"], stdout: json(d.failedEtl()) },
      { match: ["get", "nightly-etl-x7k2p"], stdout: json(d.failedEtl()) },
      { match: ["get", "ingest-q9w8e"], stdout: json(d.runningIngest()) },
      {
        match: ["list", "--output=json"],
        stdout: json([d.failedEtl(), d.runningIngest(), d.stuckPending()]),
      },
    ];
    const commands = [
      [],
      ["triage"],
      ["triage", "-A"],
      ["ctx"],
      ["wf", "list"],
      ["wf", "get", "@latest"],
      ["wf", "logs", "nightly-etl-x7k2p"],
      ["wf", "wait", "nightly-etl-x7k2p"],
      ["wf", "lint", manifest],
      ["wf", "submit", manifest],
      ["wf", "submit", "--from", "workflowtemplate/nightly-etl"],
      ["wf", "retry", "nightly-etl-x7k2p"],
      ["wf", "resubmit", "nightly-etl-x7k2p"],
      ["wf", "stop", "ingest-q9w8e"],
      ["wf", "terminate", "ingest-q9w8e"],
      ["wf", "suspend", "ingest-q9w8e"],
      ["wf", "resume", "ingest-q9w8e"],
      ["cron", "list"],
      ["cron", "get", "nightly-etl"],
      ["cron", "suspend", "nightly-etl"],
      ["cron", "resume", "nightly-etl"],
      ["template", "list"],
      ["template", "get", "nightly-etl"],
      ["template", "lint", manifest],
      ["clustertemplate", "list"],
      ["archive", "list", "--argo-server", "argo:2746", "-n", "argo"],
      ["archive", "get", "x", "--argo-server", "argo:2746", "-n", "argo"],
    ];
    let spawned = 0;
    for (const args of commands) {
      const result = run(args, { responses });
      for (const call of result.calls) {
        spawned += 1;
        expect(
          registeredOperation(call.bin, call.argv),
          `${args.join(" ")} started ${call.bin} ${call.argv.join(" ")}`,
        ).toBeDefined();
      }
    }
    expect(spawned).toBeGreaterThan(commands.length);
  });

  it("the seam only honours approvals the write gate minted for that operation", () => {
    const dir = mkdtempSync(join(tmpdir(), "awf-axi-gate-"));
    mkdirSync(join(dir, "argo-workflows-axi"));
    writeFileSync(
      join(dir, "argo-workflows-axi", "config.json"),
      JSON.stringify({
        writableTargets: [{ context: "kind-dev", namespace: "argo" }],
      }),
    );
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const target: Target = {
        mode: "kubernetes",
        context: "kind-dev",
        namespace: "argo",
        namespaceSource: "flag",
        allNamespaces: false,
        explicit: { context: true, server: false, namespace: true },
      };
      const spec = { bool: ["--apply"] };
      const preview = checkWrite(
        "wf.stop",
        parseArgs(["x"], spec, "t"),
        target,
        "wf stop x",
      );
      expect(preview.approval).toBeUndefined();
      const applied = checkWrite(
        "wf.stop",
        parseArgs(["x", "--apply"], spec, "t"),
        target,
        "wf stop x",
      );
      expect(isApprovalFor(applied.approval, "wf.stop")).toBe(true);
      expect(isApprovalFor(applied.approval, "wf.suspend")).toBe(false);
      const forged = Object.freeze({ ...applied.approval });
      expect(isApprovalFor(forged, "wf.stop")).toBe(false);
      expect(isApprovalFor({ op: "wf.stop" }, "wf.stop")).toBe(false);
      expect(() =>
        checkWrite(
          "wf.stop",
          parseArgs(["x", "--apply"], spec, "t"),
          { ...target, namespace: "prod" },
          "wf stop x",
        ),
      ).toThrow(/not allowed/);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  it("refuses write operations without an approval, or with one for another operation", () => {
    expect(() => runWrite("wf.stop", ["x"], {} as never)).toThrow(
      /without a write-gate approval/,
    );
    expect(() =>
      runWrite("wf.stop", ["x"], mintApproval("wf.suspend")),
    ).toThrow(/without a write-gate approval/);
    expect(() => runRead("wf.stop" as never, ["x"])).toThrow(
      /is a write operation/,
    );
  });

  it("refuses flags not registered for an operation", () => {
    expect(() => runRead("wf.get", ["x", "--dry-run=false"])).toThrow(
      /not registered/,
    );
    expect(() => runRead("wf.list", ["--follow"])).toThrow(/not registered/);
  });

  it("registers no streaming, token-printing or delete operation", () => {
    for (const op of Object.values(OPERATIONS)) {
      const flags = op.flags as readonly string[];
      expect(flags).not.toContain("--follow");
      expect(flags).not.toContain("--watch");
      expect(flags).not.toContain("--wait");
      expect(op.command.join(" ")).not.toMatch(
        /^(auth|delete|server|node|sync|cp|watch|wait)\b/,
      );
    }
  });

  it("v1 writes are exactly the W3 set minus wf delete", () => {
    const writes = Object.entries(OPERATIONS)
      .filter(([, op]) => op.tier === "write")
      .map(([id]) => id)
      .sort();
    expect(writes).toEqual([
      "cron.resume",
      "cron.suspend",
      "wf.priority-patch",
      "wf.resubmit",
      "wf.resubmit-native",
      "wf.resume",
      "wf.retry",
      "wf.stop",
      "wf.submit",
      "wf.suspend",
      "wf.terminate",
    ]);
    expect(REFUSALS["wf delete"].alternative).toContain("ROADMAP.md");
  });
});

describe("flag parsing", () => {
  const spec = {
    value: ["--namespace", "--status"],
    bool: ["--apply"],
    aliases: { "-n": "--namespace" },
  };

  it("accepts --flag value, --flag=value and aliases", () => {
    const parsed = parseArgs(
      ["x", "-n", "argo", "--status=Failed", "--apply"],
      spec,
      "t",
    );
    expect(parsed.positionals).toEqual(["x"]);
    expect(parsed.values.get("--namespace")).toEqual(["argo"]);
    expect(parsed.values.get("--status")).toEqual(["Failed"]);
    expect(parsed.bools.has("--apply")).toBe(true);
  });

  it("never swallows a following --flag (known or misspelled) as a value", () => {
    expect(() =>
      parseArgs(
        ["--status", "--node-field-selectors=phase=Running"],
        spec,
        "t",
      ),
    ).toThrow(/pass `--status=<value>` for a value that starts with --/);
    expect(
      parseArgs(["--status=--literal"], spec, "t").values.get("--status"),
    ).toEqual(["--literal"]);
  });

  it("takes dash-prefixed values unless the next token is one of the command's flags", () => {
    const parsed = parseArgs(["--status", "-v"], spec, "t");
    expect(parsed.values.get("--status")).toEqual(["-v"]);
    expect(
      parseArgs(["--status", "-5"], spec, "t").values.get("--status"),
    ).toEqual(["-5"]);
    expect(() => parseArgs(["--status", "--apply"], spec, "t")).toThrow(
      /requires a value/,
    );
    expect(() => parseArgs(["--status", "-n", "argo"], spec, "t")).toThrow(
      /requires a value/,
    );
  });

  it("rejects unknown, valueless, repeated and `--` input", () => {
    expect(() => parseArgs(["--nope"], spec, "t")).toThrow(
      /Unknown flag --nope/,
    );
    expect(() => parseArgs(["--status"], spec, "t")).toThrow(
      /requires a value/,
    );
    expect(() => parseArgs(["-n", "a", "-n", "b"], spec, "t")).toThrow(
      /more than once/,
    );
    expect(() => parseArgs(["--apply=yes"], spec, "t")).toThrow(
      /does not take a value/,
    );
    expect(() => parseArgs(["--", "x"], spec, "t")).toThrow(/not supported/);
  });
});

describe("redaction (S12)", () => {
  it("redacts sensitive keys and name/value pairs, counting each", () => {
    const { value, count } = redactValue({
      parameters: [
        { name: "db-password", value: "hunter2" },
        { name: "region", value: "eu" },
      ],
      env: { API_KEY: "k", HOME: "/root" },
      author: "alice",
      authorization: "raw-token-1",
      headers: [{ name: "Authorization", value: "raw-token-2" }],
    });
    expect(value.parameters[0].value).toBe("[redacted]");
    expect(value.parameters[1].value).toBe("eu");
    expect(value.env.API_KEY).toBe("[redacted]");
    expect(value.env.HOME).toBe("/root");
    expect(value.author).toBe("alice");
    expect(value.authorization).toBe("[redacted]");
    expect(value.headers[0].value).toBe("[redacted]");
    expect(count).toBe(4);
  });

  it("masks secrets in free text, best effort", () => {
    const text =
      'password=hunter2 "apiKey": "abc" Authorization: Bearer abcdefghijklmnop -----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----';
    const out = redactText(text);
    expect(out.text).not.toMatch(/hunter2|"abc"|abcdefghijklmnop|MII/);
    expect(out.count).toBeGreaterThanOrEqual(4);
    const auth = redactText("authorization=abc123 author=alice");
    expect(auth.text).toBe("authorization=[redacted] author=alice");
    expect(auth.count).toBe(1);
  });
});

describe("error translation (S13)", () => {
  it.each([
    [
      'time="t" level=fatal msg="rpc error: code = NotFound desc = workflows.argoproj.io \\"x\\" not found"',
      "NOT_FOUND",
    ],
    ["Error: rpc error: code = PermissionDenied desc = forbidden", "FORBIDDEN"],
    [
      "Error: rpc error: code = Unauthenticated desc = token is expired",
      "AUTH_REQUIRED",
    ],
    [
      'level=fatal msg="Get \\"https://1.2.3.4/apis\\": dial tcp 1.2.3.4:443: connect: connection refused"',
      "SERVER_UNREACHABLE",
    ],
    [
      'level=fatal msg="context \\"prod\\" does not exist"',
      "CONTEXT_NOT_FOUND",
    ],
    [
      'Error: rpc error: code = AlreadyExists desc = workflows.argoproj.io "a" already exists',
      "ALREADY_EXISTS",
    ],
    [
      "Error: rpc error: code = InvalidArgument desc = workflow must be Failed/Error to retry",
      "INVALID_REQUEST",
    ],
    ["something unexpected happened", "UNKNOWN"],
  ])("%s -> %s", (stderr, code) => {
    expect(mapArgoFailure(stderr).code).toBe(code);
  });

  it("extracts the message and redacts it", () => {
    expect(
      extractDetail(
        'time="t" level=info msg="x"\ntime="t" level=fatal msg="rpc error: code = NotFound desc = gone"',
      ),
    ).toBe("gone");
    expect(extractDetail("Error: bad token=abc123")).toBe(
      "bad token=[redacted]",
    );
  });
});

describe("helpers", () => {
  it("parses back-to-back JSON documents", () => {
    expect(parseJsonStream('{"a":1}\n{"b":"}{"}\n[1]')).toEqual([
      { a: 1 },
      { b: "}{" },
      [1],
    ]);
  });

  it("derives v2 and v1 pod names like Argo", () => {
    const wf = { metadata: { name: "wf-abc" } } as Workflow;
    const node = {
      id: "wf-abc-123",
      name: "wf-abc.step",
      type: "Pod",
      templateName: "tmpl",
    };
    expect(podNameOf(wf, node)).toBe("wf-abc-tmpl-123");
    expect(
      podNameOf(
        {
          metadata: {
            name: "wf-abc",
            annotations: { "workflows.argoproj.io/pod-name-format": "v1" },
          },
        },
        node,
      ),
    ).toBe("wf-abc-123");
    expect(podNameOf(wf, { ...node, name: "wf-abc" })).toBe("wf-abc");
  });
});

describe("--version fast path", () => {
  it("the bin answers --version without loading the command graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "awf-axi-fast-"));
    mkdirSync(join(dir, "dist", "bin"), { recursive: true });
    mkdirSync(join(dir, "dist", "src"));
    copyFileSync(
      join(ROOT, "dist", "bin", "argo-workflows-axi.js"),
      join(dir, "dist", "bin", "argo-workflows-axi.js"),
    );
    copyFileSync(
      join(ROOT, "dist", "src", "version.js"),
      join(dir, "dist", "src", "version.js"),
    );
    copyFileSync(join(ROOT, "package.json"), join(dir, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    writeFileSync(
      join(dir, "dist", "src", "cli.js"),
      'throw new Error("command graph loaded");\n',
    );
    const bin = join(dir, "dist", "bin", "argo-workflows-axi.js");
    const version = spawnSync(process.execPath, [bin, "--version"], {
      encoding: "utf-8",
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const other = spawnSync(process.execPath, [bin, "wf", "list"], {
      encoding: "utf-8",
    });
    expect(other.status).not.toBe(0);
    expect(other.stderr).toContain("command graph loaded");
  });
});

describe("shellQuote", () => {
  it("quotes shell metacharacters, including redirections", () => {
    expect(shellQuote("kind-dev")).toBe("kind-dev");
    expect(shellQuote("done>now")).toBe("'done>now'");
    expect(shellQuote("<context>")).toBe("'<context>'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
