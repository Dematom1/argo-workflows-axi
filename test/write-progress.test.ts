import { decode } from "@toon-format/toon";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namedWrite } from "../src/commands/wf-write.js";
import { describe, expect, it } from "vitest";
import { failedEtl, runningIngest } from "./fixtures/data.js";
import { argoCalls, json, run, writeCalls } from "./helpers.js";

const config = {
  writableTargets: [{ context: "kind-dev", namespace: "argo" }],
};
const target = ["--context", "kind-dev", "-n", "argo", "--apply"];
const wf = (name: string) => ({
  ...runningIngest(),
  metadata: { name, uid: name },
});

describe("write acceptance and overall deadline", () => {
  it("returns rejected promises for named-write validation failures", async () => {
    await expect(
      namedWrite("wf suspend")(["a", "--unknown"]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      namedWrite("wf suspend")(["a", "--timeout", "0s"]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.skipIf(process.platform === "win32")(
    "times out an unopened FIFO before any mutation",
    () => {
      const fifo = join(mkdtempSync(join(tmpdir(), "awf-fifo-")), "manifest");
      execFileSync("/usr/bin/mkfifo", [fifo]);
      const result = run(["wf", "submit", fifo, ...target, "--timeout", "1s"], {
        config,
      });
      expect(result.exitCode).toBe(1);
      expect(decode(result.stdout)).toMatchObject({ code: "TIMEOUT" });
      expect(writeCalls(result)).toEqual([]);
      expect(result.stderr).toContain("overall deadline");
    },
  );
  it("keeps accepted, unknown and not-attempted items in a partial batch", () => {
    const result = run(
      ["wf", "suspend", "a", "b", "c", ...target, "--timeout", "2s"],
      {
        config,
        responses: [
          ...["a", "b", "c"].map((name) => ({
            match: ["get", name],
            stdout: json(wf(name)),
          })),
          { match: ["suspend", "a"] },
          { match: ["suspend", "b"], sleepMs: 5000 },
        ],
      },
    );
    expect(result.exitCode).toBe(1);
    expect(decode(result.stdout)).toMatchObject({
      results: [
        { name: "a", status: "accepted", phase_before: "Running" },
        {
          name: "b",
          status: "unknown",
          result: expect.stringContaining("inspect the target before retrying"),
        },
        { name: "c", status: "not_attempted" },
      ],
    });
    expect(writeCalls(result)).toHaveLength(2);
    expect(argoCalls(result).filter((args) => args[0] === "get")).toHaveLength(
      3,
    );
    expect(result.stderr).toContain("overall deadline");
    expect(result.stdout).not.toContain("elapsed");
  });

  it("keeps planned no-ops successful after the batch deadline expires", () => {
    const alreadySuspended = {
      ...wf("b"),
      spec: { suspend: true },
    };
    const result = run(
      ["wf", "suspend", "a", "b", ...target, "--timeout", "1s"],
      {
        config,
        responses: [
          { match: ["get", "a"], stdout: json(wf("a")) },
          { match: ["get", "b"], stdout: json(alreadySuspended) },
          { match: ["suspend", "a"], sleepMs: 5000 },
        ],
      },
    );
    expect(decode(result.stdout)).toMatchObject({
      results: [
        { name: "a", status: "unknown" },
        { name: "b", status: "no_op", result: "already_suspended" },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(writeCalls(result)).toHaveLength(1);
  });

  it("spends the same budget on preflight and never starts expired mutations", () => {
    const result = run(["wf", "stop", "a", "b", ...target, "--timeout", "1s"], {
      config,
      responses: [{ match: ["get", "a"], sleepMs: 5000 }],
    });
    expect(result.exitCode).toBe(1);
    expect(decode(result.stdout)).toMatchObject({
      results: [
        { name: "a", status: "not_attempted" },
        { name: "b", status: "not_attempted" },
      ],
    });
    expect(writeCalls(result)).toEqual([]);
    expect(argoCalls(result)).toHaveLength(1);
  });

  it("preserves a memoized creation when its priority patch fails", () => {
    const source = failedEtl();
    const result = run(
      [
        "wf",
        "resubmit",
        source.metadata.name,
        "--memoized",
        "--new",
        "--priority",
        "3",
        ...target,
      ],
      {
        config,
        responses: [
          { match: ["get", source.metadata.name], stdout: json(source) },
          { match: ["resubmit"], stdout: json(wf("created-copy")) },
          { bin: "kubectl", match: ["patch"], exit: 1, stderr: "forbidden" },
        ],
      },
    );
    expect(result.exitCode).toBe(1);
    expect(decode(result.stdout)).toMatchObject({
      results: [
        {
          source: source.metadata.name,
          name: "created-copy",
          status: "accepted_follow_up_failed",
        },
      ],
    });
  });

  it("does not invent an identity or Pending phase from malformed accepted output", () => {
    const result = run(
      ["wf", "resubmit", "a", "--memoized", "--new", ...target],
      {
        config,
        responses: [
          {
            match: ["get", "a"],
            stdout: json({ ...failedEtl(), metadata: { name: "a" } }),
          },
          { match: ["resubmit"], stdout: "not json" },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toMatchObject({
      results: [
        {
          name: "(unknown)",
          status: "accepted_identity_unknown",
          phase: "unobserved",
        },
      ],
    });
  });
});
