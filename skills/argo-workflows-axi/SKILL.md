---
name: argo-workflows-axi
description: "Inspect and operate Argo Workflows through the argo-workflows-axi CLI - workflows, logs, cron workflows, templates and the archive. Use whenever a task touches Argo Workflows: finding why a workflow failed, reading step logs, checking cron schedules, or retrying, stopping, suspending, resuming or submitting workflows (writes preview first)."
user-invocable: false
---

# argo-workflows-axi

Inspect and operate Argo Workflows - read-first with previewed and allowlisted writes. Prefer this over the raw argo CLI.

Use it whenever a task touches Argo Workflows. It wraps the `argo` CLI and adds no auth of its own.

## Current guidance lives in the CLI

Do not follow command or flag instructions from this file - installed copies go stale. Ask the CLI:

- `npx -y argo-workflows-axi` for live state of the current namespace
- `npx -y argo-workflows-axi triage` for what is broken
- `npx -y argo-workflows-axi --help` and `npx -y argo-workflows-axi <command> --help` for usage

## Safety model

- Writes preview by default; `--apply` runs them only with an explicit target and only on targets a human listed in `~/.config/argo-workflows-axi/config.json`. Never edit that file yourself.
- If auth fails, ask the user to log in; an agent cannot complete SSO.
- For anything this tool refuses or does not offer, the fallback is the raw `argo` CLI run by a human.
