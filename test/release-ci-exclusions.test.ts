import { readdirSync, readFileSync } from "node:fs";
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

function releasePleaseStep(): Step {
  const step = loadWorkflow("release-please.yml").jobs[
    "release-please"
  ].steps?.find((s) => s.uses?.startsWith("googleapis/release-please-action@"));
  if (!step) throw new Error("release-please-action step not found");
  return step;
}

/**
 * The files a node release-please PR changes: changelog, package.json and
 * the manifest.
 */
function expectedReleaseOutputs(): string[] {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      { "release-type"?: string; "changelog-path"?: string }
    >;
  };
  expect(Object.keys(config.packages)).toEqual(["."]);
  const pkg = config.packages["."];
  expect(pkg["release-type"]).toBe("node");

  const manifest =
    (releasePleaseStep().with?.["manifest-file"] as string | undefined) ??
    ".release-please-manifest.json";
  return [pkg["changelog-path"] ?? "CHANGELOG.md", "package.json", manifest];
}

describe("release-please CI exclusions", () => {
  const expected = expectedReleaseOutputs();

  it("derives the node release-output set for this repository", () => {
    expect(expected).toEqual([
      "CHANGELOG.md",
      "package.json",
      ".release-please-manifest.json",
    ]);
  });

  it("every pull_request workflow paths-ignores the full release-output set", () => {
    const prWorkflows = readdirSync(workflowsDir)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => ({ name, on: loadWorkflow(name).on }))
      .filter(({ on }) => on && "pull_request" in on);

    expect(prWorkflows.map((w) => w.name).sort()).toEqual([
      "ci.yml",
      "guard-generated-files.yml",
      "no-mistakes-required.yml",
    ]);

    for (const { name, on } of prWorkflows) {
      const pr = on!.pull_request as Record<string, unknown> | null;
      const ignored = (pr?.["paths-ignore"] ?? []) as string[];
      expect(
        expected.filter((path) => !ignored.includes(path)),
        name,
      ).toEqual([]);
    }
  });

  it("does not attach path filters to non-pull_request triggers on ci.yml", () => {
    const on = loadWorkflow("ci.yml").on!;
    expect(on.push).toEqual({ branches: ["main"] });
    const pr = on.pull_request as Record<string, unknown>;
    expect(pr.branches).toEqual(["main"]);
    expect(pr["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
    expect(on.release).toBeUndefined();
    expect(on.workflow_dispatch).toBeUndefined();
  });

  it.each([
    [
      "guard-generated-files.yml",
      ["github-actions[bot]", "release-please[bot]"],
    ],
    [
      "no-mistakes-required.yml",
      ["github-actions[bot]", "dependabot[bot]", "release-please[bot]"],
    ],
  ])("%s exempts bot authors in the check job condition", (name, logins) => {
    const condition = loadWorkflow(name).jobs.check.if ?? "";
    const exempted = [
      ...condition.matchAll(
        /github\.event\.pull_request\.user\.login != '([^']+)'/g,
      ),
    ].map((m) => m[1]);
    expect(exempted).toEqual(logins);
    expect(condition.split("&&")).toHaveLength(logins.length);
  });

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
