// Generates skills/argo-workflows-axi/SKILL.md from src/skill.ts.
//
//   pnpm run build:skill   # write the file
//   pnpm run check:skill   # fail (exit 1) if the committed file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createSkillMarkdown } from "../src/skill.js";

const target = new URL(
  "../skills/argo-workflows-axi/SKILL.md",
  import.meta.url,
);
const expected = createSkillMarkdown();

if (process.argv.includes("--check")) {
  let actual: string | null = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // A missing file falls through to the mismatch branch.
  }
  if (actual !== expected) {
    console.error(
      "skills/argo-workflows-axi/SKILL.md is out of date. Run `pnpm run build:skill` and commit the result.",
    );
    process.exit(1);
  }
  console.log("skills/argo-workflows-axi/SKILL.md is up to date.");
} else {
  await mkdir(new URL("../skills/argo-workflows-axi/", import.meta.url), {
    recursive: true,
  });
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
