import { DESCRIPTION } from "./cli.js";

// Trigger string agents match against to auto-load the skill.
export const SKILL_DESCRIPTION =
  "Inspect and operate Argo Workflows through the argo-workflows-axi CLI - workflows, logs, cron workflows, templates and the archive. " +
  "Use whenever a task touches Argo Workflows: finding why a workflow failed, reading step logs, checking cron schedules, " +
  "or retrying, stopping, suspending, resuming or submitting workflows (writes preview first).";

// Hard cap so a regeneration cannot re-inflate the stub with CLI-owned guidance.
export const MAX_SKILL_MARKDOWN_CHARS = 2500;

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the installable SKILL.md. This is a discovery stub: the live home
 * view, `--help` and per-command `--help` are the source of truth.
 */
export function createSkillMarkdown(): string {
  const markdown = `---
name: argo-workflows-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
---

# argo-workflows-axi

${DESCRIPTION}.

Use it whenever a task touches Argo Workflows. It wraps the \`argo\` CLI and adds no auth of its own.

## Current guidance lives in the CLI

Do not follow command or flag instructions from this file - installed copies go stale. Ask the CLI:

- \`npx -y argo-workflows-axi\` for live state of the current namespace
- \`npx -y argo-workflows-axi triage\` for what is broken
- \`npx -y argo-workflows-axi --help\` and \`npx -y argo-workflows-axi <command> --help\` for usage

## Safety model

- Writes preview by default; \`--apply\` runs them only with an explicit target and only on targets a human listed in \`~/.config/argo-workflows-axi/config.json\`. Never edit that file yourself.
- If auth fails, ask the user to log in; an agent cannot complete SSO.
- For anything this tool refuses or does not offer, the fallback is the raw \`argo\` CLI run by a human.
`;

  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it a stub under ${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }
  return markdown;
}
