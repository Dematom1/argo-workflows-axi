# Roadmap

v1 is read-first with a small, gated set of writes. This file tracks what comes after it.

## Adding writes

Every new write follows the same rules as the v1 writes, so the safety model stays one model:

- It is registered as a `write` operation in `src/registry.ts`, with an explicit flag list. Nothing else is reachable.
- It previews by default and runs only with `--apply`, an explicit target (`-n` plus `--context` or `--argo-server`), and a target a human listed in the local allowlist file.
- It reports idempotent no-ops in-band with exit 0, and exit 1 only when the intent cannot be met.
- It moves out of `REFUSALS` (which today answers with the reason and the human route).

Candidates, roughly in order:

1. **`wf delete`**: names only, at most 20 per call, no `--force`. Held back from v1 pending the maintainer's decision.
2. **Selector-based bulk writes** (`-l`, `--older`, `--status`) for stop, terminate, retry, resubmit and delete. Always previewed, and the previewed count must be echoed back to run (for example `--apply --count 37`), so a typo in a selector cannot touch more than what was previewed.
3. **Cron workflow writes**: `cron create`, `cron update`, `cron delete`. These change what runs unattended, so previews show the schedule, timezone and concurrency policy that would take effect.
4. **`cron backfill`**: can create up to 1000 workflows. It needs the echoed count from item 2 and a lower default cap.
5. **WorkflowTemplate and ClusterWorkflowTemplate writes**: `create`, `update`, `delete`, with `lint` as a mandatory preflight.
6. **Archive writes**: `archive retry`, `archive resubmit`, `archive delete` (Argo Server mode only).
7. **`cp`** (artifact download) with an explicit `--dir`, since it writes local files.

## Other work

- **Argo Server REST backend** behind the same seam, for server-side field projection (no huge `status.nodes` transfer for lists), server-side filters and log byte limits. This also enables `wf logs --stream stdout|stderr`, which the `argo` CLI cannot do.
- **Real verification pass** against a throwaway local cluster (kind or k3d with the Argo Workflows quick-start), run only after the maintainer approves it: record fixtures and stderr corpora from the oldest and newest supported versions (v3.7 and v4.1) to replace the hand-built ones, and confirm the error-translation table.
- **Retune defaults** (supported version range, list limits, triage window) once the target installs' versions, mode, archive and namespaces are known.
- **AXI community catalog** submission after v1.
