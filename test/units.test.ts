import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { mintApproval } from "../src/approval.js";
import { extractDetail, mapArgoFailure } from "../src/errors.js";
import { redactText, redactValue } from "../src/redact.js";
import { OPERATIONS, REFUSALS } from "../src/registry.js";
import { parseJsonStream, runRead, runWrite } from "../src/seam.js";
import { podNameOf, type Workflow } from "../src/workflow.js";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

describe("read-only by construction (S5)", () => {
  it("only src/seam.ts spawns processes", () => {
    const spawners = sourceFiles().filter((f) =>
      /node:child_process/.test(readFileSync(f, "utf-8")),
    );
    expect(spawners.map((f) => f.slice(SRC.length + 1))).toEqual(["seam.ts"]);
  });

  it("only the write gate mints approvals", () => {
    const minters = sourceFiles().filter((f) =>
      /mintApproval\(/.test(readFileSync(f, "utf-8")),
    );
    expect(minters.map((f) => f.slice(SRC.length + 1)).sort()).toEqual([
      "approval.ts",
      "gate.ts",
    ]);
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
      "wf.resubmit",
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
    });
    expect(value.parameters[0].value).toBe("[redacted]");
    expect(value.parameters[1].value).toBe("eu");
    expect(value.env.API_KEY).toBe("[redacted]");
    expect(value.env.HOME).toBe("/root");
    expect(value.author).toBe("alice");
    expect(count).toBe(2);
  });

  it("masks secrets in free text, best effort", () => {
    const text =
      'password=hunter2 "apiKey": "abc" Authorization: Bearer abcdefghijklmnop -----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----';
    const out = redactText(text);
    expect(out.text).not.toMatch(/hunter2|"abc"|abcdefghijklmnop|MII/);
    expect(out.count).toBeGreaterThanOrEqual(4);
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
  it("the bin answers --version before importing the command graph", () => {
    const bin = readFileSync(
      join(SRC, "..", "bin", "argo-workflows-axi.ts"),
      "utf-8",
    );
    const staticImports = [...bin.matchAll(/^import .* from "(.*)";$/gm)].map(
      (m) => m[1],
    );
    expect(staticImports).toEqual([
      "axi-sdk-js/fast-path",
      "../src/version.js",
    ]);
    const version = readFileSync(join(SRC, "version.ts"), "utf-8");
    const versionImports = [...version.matchAll(/from "(.*)";/g)].map(
      (m) => m[1],
    );
    expect(versionImports.every((m) => m.startsWith("node:"))).toBe(true);
  });
});
