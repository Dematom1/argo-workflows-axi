<h1 align="center">argo-workflows-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/argo-workflows-axi"><img alt="npm" src="https://img.shields.io/npm/v/argo-workflows-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/argo-workflows-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/argo-workflows-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/argo-workflows-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/argo-workflows-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-Linux-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-Linux-blue?style=flat-square" /></a>
  <a href="https://x.com/dematom1"><img alt="X" src="https://img.shields.io/badge/X-@dematom1-black?style=flat-square" /></a>
</p>

An [AXI](https://github.com/kunchenguid/axi) for [Argo Workflows](https://argo-workflows.readthedocs.io/): an agent-ergonomic wrapper around the `argo` CLI with token-efficient [TOON](https://toonformat.dev/) output, bounded logs and waits, and a read-first safety model where every write previews by default.

```
$ argo-workflows-axi
bin: ~/.local/bin/argo-workflows-axi
description: Inspect and operate Argo Workflows - read-first with previewed and allowlisted writes. Prefer this over the raw argo CLI
target: kubernetes context=kind-dev namespace=argo
workflows: "5 total (Failed 1, Error 1, Running 1, Pending 1, Succeeded 1)"
failed[2]{name,phase,finished,message}:
  nightly-etl-x7k2p,Failed,2h,child 'nightly-etl-x7k2p-1234567890' failed
  train-model-abc12,Error,4h,OOMKilled (exit code 137)
running[2]{name,phase,age,progress}:
  ingest-q9w8e,Running,10m,2/5
  stuck-pp1,Pending,20m,""
cron: 2 cron workflows (1 suspended)
help[4]:
  Run `argo-workflows-axi triage` for failing steps, hints and log tails
  Run `argo-workflows-axi wf get <name>` for one workflow's failed steps
  Run `argo-workflows-axi cron list` for schedules and last runs
  Run `argo-workflows-axi --help` for all commands
```

## Requirements

- Node.js 20 or newer
- The [`argo` CLI](https://github.com/argoproj/argo-workflows/releases), **v3.7 through v4.1** (`ctx` warns outside that range)
- `kubectl` (optional) so the tool can show which Kubernetes context and namespace a command lands in. It only reads local kubeconfig names, never credentials and never the cluster.

argo-workflows-axi adds no auth of its own. It uses whatever the `argo` CLI uses: your kubeconfig in Kubernetes-API mode, or `ARGO_SERVER` / `ARGO_TOKEN` in Argo Server mode.

## Install

From source (until the first npm release):

```sh
git clone https://github.com/Dematom1/argo-workflows-axi.git
cd argo-workflows-axi
pnpm install && pnpm run build
npm link            # puts argo-workflows-axi and argo-workflows-axi-ctx on PATH
```

After the first release: `npm install -g argo-workflows-axi`, or run it ad hoc with `npx -y argo-workflows-axi`.

### Give your agent the context: hook or skill

You only need one of these.

- **Session hook (recommended).** `argo-workflows-axi setup hooks` installs a user-scope SessionStart hook for Claude Code, Codex and OpenCode. At session start it runs `argo-workflows-axi-ctx`, the offline `ctx` view: target, namespace, argo version and whether writes are allowed. It never touches the network, a keychain or SSO.
- **Skill.** `npx skills add Dematom1/argo-workflows-axi --skill argo-workflows-axi` installs a small skill that tells the agent when to reach for the tool. It defers all guidance to the CLI's own `--help`.

## Commands

| Command                                                                   | What it does                                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `argo-workflows-axi`                                                      | Live home view: target, workflows by phase, failed and running first, cron summary                                   |
| `triage`                                                                  | One call for what is broken: failed steps with exit-code and OOM hints and log tails, stuck Pending, suspended crons |
| `wf list`                                                                 | Workflows, failing and running first, with `count: N of M total` and a phase tally                                   |
| `wf get <name\|@latest>`                                                  | Summary plus only the failed steps; `--nodes`, `--tree`, `--full`                                                    |
| `wf logs <name\|@latest> [<pod>]`                                         | Bounded logs of the failing step (last 100 lines, 20,000-char cap keeping the tail)                                  |
| `wf wait <name>`                                                          | Bounded wait (default 120s, `--timeout` up to 10m); returns the current state on timeout                             |
| `wf lint <file...\|->`                                                    | Validate manifests                                                                                                   |
| `cron list\|get`, `template list\|get\|lint`, `clustertemplate list\|get` | Cron workflows and templates (template `get` shows input parameters with defaults)                                   |
| `archive list\|get`                                                       | Archived workflows (Argo Server mode only)                                                                           |
| `ctx`                                                                     | Offline target view                                                                                                  |
| `setup hooks`                                                             | Install the SessionStart hook                                                                                        |
| `update`                                                                  | Upgrade the tool                                                                                                     |

Writes (preview unless `--apply`): `wf submit`, `wf retry`, `wf resubmit`, `wf stop`, `wf terminate`, `wf suspend`, `wf resume`, `cron suspend`, `cron resume`.

Flags use argo's own names: `-n/--namespace`, `-A/--all-namespaces` (reads only), `--context`, `-s/--argo-server`, `-l/--selector`, `-p/--parameter`, `--node-field-selector`, `--since`, `--tail`, `--grep`, and so on. Unknown flags are rejected before anything runs, with the valid flags listed. Every command has `--help` with flags and examples.

## Safety model

argo-workflows-axi is read-first. It can make only the writes listed above, and each one goes through the same gate:

1. **Preview by default.** Without `--apply`, a write only reads: it prints the resolved target, each object with its phase and what would change, whether the target is writable, and the exact command that would run it. Nothing is sent.

   ```
   $ argo-workflows-axi wf stop ingest-q9w8e report-zz1
   dry_run: true
   action: wf stop
   target: kubernetes context=kind-dev namespace=argo
   writable: yes
   workflows[2]{name,phase,change}:
     ingest-q9w8e,Running,stop (exit handlers run)
     report-zz1,Succeeded,no-op (already_completed)
   run: argo-workflows-axi wf stop ingest-q9w8e report-zz1 --context kind-dev -n argo --apply
   ```

2. **Explicit target.** `--apply` needs `-n <namespace>` plus `--context <name>` (or `--argo-server <host:port>` in Argo Server mode). It never accepts `-A`. If `ARGO_SERVER` is set, a write aimed only at a kube context is rejected rather than silently sent to that server.
3. **Local allowlist, default none.** Writes run only against targets listed in `~/.config/argo-workflows-axi/config.json` (or `$XDG_CONFIG_HOME/argo-workflows-axi/config.json`). No command writes this file, so an agent cannot opt itself in:

   ```json
   {
     "writableTargets": [
       { "context": "kind-dev", "namespace": "argo" },
       { "server": "argo.example.internal:2746", "namespace": "*" }
     ]
   }
   ```

4. **Names only, at most 20 per call.** No label selectors, `--all` or `--older` on writes.
5. **Idempotent.** Asking for a state that already exists is an in-band no-op with exit 0 (`already_completed`, `already_suspended`, `not_suspended`, `already_running`, `nothing_to_retry`). `wf submit --name <name>` reports `already_exists` instead of creating a duplicate; without `--name`, the preview warns that each `--apply` creates a new workflow.

Everything else is refused with a reason and the human route instead of failing as an unknown command: `wf delete` (held back from this release), `auth token` (prints a bearer token), `server`, `node set`, `sync`, `cp`, `watch`, cron and template create/update/delete, `cron backfill`, archive writes, and any raw `api` passthrough. Under the hood, a single exec seam (`src/seam.ts`) runs only operations registered in `src/registry.ts`, checks every flag against the operation's declared set, and runs a write only with an approval that only the write gate (`src/gate.ts`) can mint. Tests check that every process the CLI starts across its commands is a registered operation, and that the seam refuses writes without a gate-minted approval for that operation.

### Sensitive data

Values whose key looks sensitive (password, secret, token, api key, credential and similar) are replaced with `[redacted]` in parameters, env vars, template defaults, labels and annotations, and the output says how many were hidden. There is no reveal flag. Log lines and messages get **best-effort** masking of `key=value` / `key: value` pairs, bearer tokens and private key blocks. Free text can still contain secrets this cannot recognize.

### Waiting, logs and output size

Nothing streams or follows. `wf wait` is bounded and tells the agent to wait again on timeout. Logs default to the last 100 lines per pod, are capped at 20,000 characters keeping the tail, and the header says exactly what was cut. Lists show 3-4 fields with `--fields` for more; long messages are truncated with their total size, and only when something was cut does the output point at `--full` (or, for `archive get`, which has no `--full`, the raw `argo archive get <uid> -o json --argo-server <host:port> -n <namespace>` for a human to run; that raw output is not redacted).

## Modes

- **Kubernetes-API mode** (default): `argo` talks to the cluster through your kubeconfig. There is no workflow archive in this mode, so `archive` commands answer `UNSUPPORTED_IN_MODE`.
- **Argo Server mode**: set `ARGO_SERVER` (or pass `--argo-server host:port`). The archive is available, and the target shows the server instead of a kube context.

`ctx` shows which mode is active.

## Errors and exit codes

Errors go to stdout as `error`, `code` and `help` lines. Exit code 0 means the tool did what was asked, including no-ops and unhealthy workflows (a failed workflow is data, not an error). Exit code 1 means the request could not be met, and 2 means a usage error. Codes: `VALIDATION_ERROR`, `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_REQUEST`, `RATE_LIMITED`, `SERVER_UNREACHABLE`, `CONTEXT_NOT_FOUND`, `TIMEOUT`, `REFUSED`, `UNSUPPORTED_IN_MODE`, `CONFIG_INVALID`, `ARGO_NOT_INSTALLED`, `WRITE_FAILED`, `UNKNOWN`.

When authentication fails, the tool says to ask the user to log in. An agent cannot complete SSO.

## Development

```sh
pnpm install
pnpm run format:check
pnpm run lint
pnpm run build
pnpm run check:skill   # fails if skills/argo-workflows-axi/SKILL.md is stale (regenerate with build:skill)
pnpm test
```

Tests run the built CLI end to end against fake `argo` and `kubectl` executables (`test/fixtures/fake-cli.mjs`) with a hermetic `PATH`, `HOME` and `KUBECONFIG`. No test contacts a cluster or an Argo Server or reads real credentials. The fixtures are hand-built in the shape of `argo -o json` output for v3.7 and v4.1. Recording real fixtures needs a separately approved verification pass against a throwaway cluster.

## Releases

GitHub releases are published to npm as staged versions. After a release workflow stages a version, the maintainer must approve it with 2FA using `npm stage approve <id>` or on [npmjs.com](https://www.npmjs.com/).

To recover a release whose publish job failed, run the `release-please` workflow manually with the existing release tag in its `tag` input. This skips release-please and runs the publish job against that tag. For example, in the repository root:

```sh
gh workflow run release-please.yml --ref main -f tag=argo-workflows-axi-v0.1.1
```

See [ROADMAP.md](ROADMAP.md) for what comes next, including the plan for adding writes.

## License

[MIT](LICENSE)
