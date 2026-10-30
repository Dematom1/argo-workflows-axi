import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<
    string,
    { if?: string; permissions?: Record<string, string>; steps?: Step[] }
  >;
};

function loadWorkflow(name: string): Workflow {
  const doc = parse(readFileSync(join(workflowsDir, name), "utf8")) as Record<
    string | boolean,
    unknown
  >;
  // YAML 1.1 may parse a bare `on:` key as boolean true.
  return { ...doc, on: doc.on ?? doc[true] } as Workflow;
}

describe("release-please publishing", () => {
  it("publishes through npm trusted publishing without a stored npm token", () => {
    const doc = loadWorkflow("release-please.yml");
    expect(doc.permissions).toEqual({});
    expect(doc.jobs.publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(
      doc.jobs["release-please"].permissions?.["id-token"],
    ).toBeUndefined();

    const publishSteps = doc.jobs.publish.steps ?? [];
    const stageStep = publishSteps.find((step) =>
      step.run?.includes("npm stage publish"),
    );
    expect(stageStep).toBeDefined();
    const script = stageStep?.run?.match(
      /node --input-type=commonjs <<'NODE'\n([\s\S]*?)\nNODE/,
    )?.[1];
    expect(script).toBeDefined();

    const temp = mkdtempSync(join(tmpdir(), "release-summary-"));
    try {
      const bin = join(temp, "bin");
      const packageDir = join(temp, "package");
      const summary = join(temp, "summary.md");
      const npm = join(bin, "npm");
      const pkg = { name: "example-package", version: "1.2.3" };
      const staged = [{ id: "stage-123", version: pkg.version }];
      mkdirSync(bin);
      mkdirSync(packageDir);
      writeFileSync(join(packageDir, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        npm,
        `#!/bin/sh\nprintf '%s' '${JSON.stringify(staged)}'\n`,
      );
      chmodSync(npm, 0o755);

      const result = spawnSync(process.execPath, ["--input-type=commonjs"], {
        cwd: packageDir,
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(summary, "utf8")).toBe(
        "Stage ID: stage-123\nPackage: example-package\nVersion: 1.2.3\nWaiting for approval: run axi-approve\n",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    expect(
      publishSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
        ?.with?.ref,
    ).toBe(
      "refs/tags/${{ inputs.tag || needs.release-please.outputs.tag_name }}",
    );

    const secretRefs = Object.values(doc.jobs)
      .flatMap((job) => job.steps ?? [])
      .flatMap((s) => [
        ...Object.entries(s.env ?? {}),
        ...Object.entries(s.with ?? {}),
      ])
      .filter(([, value]) => String(value).includes("secrets."));
    expect(secretRefs).toEqual([["token", "${{ secrets.GITHUB_TOKEN }}"]]);
    expect(publishSteps.flatMap((s) => Object.keys(s.env ?? {}))).not.toContain(
      "NODE_AUTH_TOKEN",
    );
  });
});
