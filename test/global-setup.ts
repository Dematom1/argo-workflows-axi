import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";

// Tests drive the built CLI end to end, so build once before the run.
export default function setup(project: TestProject): void {
  const build = (): void => {
    execFileSync(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "-p", "."],
      {
        cwd: project.config.root,
        stdio: "inherit",
      },
    );
  };
  build();
  project.onTestsRerun(build);
}
