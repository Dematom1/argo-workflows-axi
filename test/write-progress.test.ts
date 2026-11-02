import { decode } from "@toon-format/toon";
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
