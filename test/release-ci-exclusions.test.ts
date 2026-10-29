import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(publishSteps.map((s) => s.run)).toContain(
      "npm publish --access public --provenance",
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
