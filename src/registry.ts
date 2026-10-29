/**
 * The allowlist and refusal registries (design S5).
 *
 * `OPERATIONS` is the complete set of dependency invocations this tool can
 * make. The seam (`src/seam.ts`) refuses anything not registered here, checks
 * every flag against the operation's declared set, and only runs `write`
 * operations when handed an approval minted by the write gate (`src/gate.ts`).
 *
 * `REFUSALS` lists Argo verbs an agent may reasonably ask for that this tool
 * deliberately does not offer. Each answers `REFUSED` with the reason and the
 * human route, instead of failing as an unknown command.
 */

export type Tier = "read" | "local" | "write";

export interface Operation {
  /** Executable the operation runs. */
  bin: "argo" | "kubectl";
  /** Subcommand path, fixed per operation. */
  command: string[];
  tier: Tier;
  /** Flags the caller may pass (always as `--flag` or `--flag=value`). */
  flags: string[];
  /** Whether the target flags (`--context`, `--argo-server`, `--namespace`) apply. */
  targeted: boolean;
}

const READ_TARGET = true;

export const OPERATIONS = {
  // Workflows
  "wf.list": {
    bin: "argo",
    command: ["list"],
    tier: "read",
    flags: [
      "--output",
      "--all-namespaces",
      "--status",
      "--since",
      "--older",
      "--selector",
      "--prefix",
    ],
    targeted: READ_TARGET,
  },
  "wf.get": {
    bin: "argo",
    command: ["get"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  "wf.logs": {
    bin: "argo",
    command: ["logs"],
    tier: "read",
    flags: ["--tail", "--grep", "--since", "--previous", "--container"],
    targeted: READ_TARGET,
  },
  "wf.lint": {
    bin: "argo",
    command: ["lint"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  // CronWorkflows
  "cron.list": {
    bin: "argo",
    command: ["cron", "list"],
    tier: "read",
    flags: ["--output", "--all-namespaces", "--selector"],
    targeted: READ_TARGET,
  },
  "cron.get": {
    bin: "argo",
    command: ["cron", "get"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  // WorkflowTemplates and ClusterWorkflowTemplates
  "template.list": {
    bin: "argo",
    command: ["template", "list"],
    tier: "read",
    flags: ["--output", "--all-namespaces", "--selector"],
    targeted: READ_TARGET,
  },
  "template.get": {
    bin: "argo",
    command: ["template", "get"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  "template.lint": {
    bin: "argo",
    command: ["template", "lint"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  "clustertemplate.list": {
    bin: "argo",
    command: ["cluster-template", "list"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  "clustertemplate.get": {
    bin: "argo",
    command: ["cluster-template", "get"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  // Archive (Argo Server mode only)
  "archive.list": {
    bin: "argo",
    command: ["archive", "list"],
    tier: "read",
    flags: ["--output", "--selector"],
    targeted: READ_TARGET,
  },
  "archive.get": {
    bin: "argo",
    command: ["archive", "get"],
    tier: "read",
    flags: ["--output"],
    targeted: READ_TARGET,
  },
  // Local only: no network, no credentials
  "local.version": {
    bin: "argo",
    command: ["version"],
    tier: "local",
    flags: ["--short"],
    targeted: false,
  },
  "local.kube-current-context": {
    bin: "kubectl",
    command: ["config", "current-context"],
    tier: "local",
    flags: [],
    targeted: false,
  },
  "local.kube-context-namespace": {
    bin: "kubectl",
    command: ["config", "view"],
    tier: "local",
    flags: ["--minify", "--output", "--context"],
    targeted: false,
  },
  // Gated writes (v1 set, design W3; `wf delete` held back, see REFUSALS)
  "wf.submit": {
    bin: "argo",
    command: ["submit"],
    tier: "write",
    flags: [
      "--from",
      "--parameter",
      "--name",
      "--generate-name",
      "--entrypoint",
      "--serviceaccount",
      "--labels",
      "--priority",
      "--output",
    ],
    targeted: true,
  },
  "wf.retry": {
    bin: "argo",
    command: ["retry"],
    tier: "write",
    flags: [
      "--node-field-selector",
      "--restart-successful",
      "--parameter",
      "--output",
    ],
    targeted: true,
  },
  "wf.resubmit": {
    bin: "argo",
    command: ["resubmit"],
    tier: "write",
    flags: ["--memoized", "--parameter", "--priority", "--output"],
    targeted: true,
  },
  "wf.stop": {
    bin: "argo",
    command: ["stop"],
    tier: "write",
    flags: ["--message", "--node-field-selector"],
    targeted: true,
  },
  "wf.terminate": {
    bin: "argo",
    command: ["terminate"],
    tier: "write",
    flags: [],
    targeted: true,
  },
  "wf.suspend": {
    bin: "argo",
    command: ["suspend"],
    tier: "write",
    flags: [],
    targeted: true,
  },
  "wf.resume": {
    bin: "argo",
    command: ["resume"],
    tier: "write",
    flags: ["--node-field-selector"],
    targeted: true,
  },
  "cron.suspend": {
    bin: "argo",
    command: ["cron", "suspend"],
    tier: "write",
    flags: [],
    targeted: true,
  },
  "cron.resume": {
    bin: "argo",
    command: ["cron", "resume"],
    tier: "write",
    flags: [],
    targeted: true,
  },
} as const satisfies Record<string, Operation>;

export type OperationId = keyof typeof OPERATIONS;

type OpsOfTier<T extends Tier> = {
  [K in OperationId]: (typeof OPERATIONS)[K]["tier"] extends T ? K : never;
}[OperationId];

export type ReadOperationId = OpsOfTier<"read" | "local">;
export type WriteOperationId = OpsOfTier<"write">;

export interface Refusal {
  reason: string;
  alternative: string;
}

const ROADMAP =
  "See ROADMAP.md (`Adding writes`) in the argo-workflows-axi repository";

/**
 * Keyed by the argo-workflows-axi command path a user or agent would type.
 */
export const REFUSALS: Record<string, Refusal> = {
  "wf delete": {
    reason:
      "Deleting workflows is not in this release; it is held back pending the maintainer's decision",
    alternative: `Ask a human to run \`argo delete <name> -n <namespace>\`. ${ROADMAP}`,
  },
  "wf watch": {
    reason:
      "Streaming commands hang agents; this tool never streams or follows",
    alternative: "Run `argo-workflows-axi wf wait <name>` (bounded) instead",
  },
  "wf node": {
    reason:
      "`node set` can fabricate node results and outputs; it is expert-only",
    alternative:
      "Ask a human to run `argo node set ...` if it is really needed",
  },
  "wf cp": {
    reason: "Artifact download writes local files; not offered in this release",
    alternative: `Ask a human to run \`argo cp <name> <dir>\`. ${ROADMAP}`,
  },
  "wf create": {
    reason: "Workflows are created by submitting them",
    alternative:
      "Run `argo-workflows-axi wf submit <file>` or `wf submit --from workflowtemplate/<name>` (previews first)",
  },
  auth: {
    reason:
      "`argo auth token` prints a bearer token; credentials are never shown by this tool",
    alternative:
      "Ask a human to run `argo auth token` in their own terminal if they need it",
  },
  server: {
    reason: "Starting an Argo Server is out of scope for an agent tool",
    alternative: "Ask a human to run `argo server`",
  },
  sync: {
    reason:
      "Sync limits (semaphores, mutexes) change concurrency for other people's workflows",
    alternative: `Ask a human to run \`argo sync ...\`. ${ROADMAP}`,
  },
  "executor-plugin": {
    reason:
      "Building executor plugins is a local developer task, not an agent operation",
    alternative: "Run `argo executor-plugin build` directly",
  },
  convert: {
    reason:
      "Manifest conversion is a local file operation outside this tool's scope",
    alternative: "Run `argo convert` directly",
  },
  completion: {
    reason: "Shell completion is for humans",
    alternative: "Run `argo completion <shell>` directly",
  },
  api: {
    reason:
      "There is no raw passthrough in argo-workflows-axi; the operation allowlist is closed by design",
    alternative:
      "Use the raw `argo` CLI yourself, or ask a human, for anything this tool does not offer",
  },
  "cron create": {
    reason:
      "CronWorkflow creation changes what runs unattended; not in this release",
    alternative: `Ask a human to run \`argo cron create <file>\`. ${ROADMAP}`,
  },
  "cron update": {
    reason:
      "CronWorkflow updates change what runs unattended; not in this release",
    alternative: `Ask a human to run \`argo cron update <file>\`. ${ROADMAP}`,
  },
  "cron delete": {
    reason: "CronWorkflow deletion is not in this release",
    alternative: `Ask a human to run \`argo cron delete <name>\`. ${ROADMAP}`,
  },
  "cron backfill": {
    reason: "Backfill can create up to 1000 workflows; not in this release",
    alternative: `Ask a human to run \`argo cron backfill ...\`. ${ROADMAP}`,
  },
  "template create": {
    reason: "WorkflowTemplate writes are not in this release",
    alternative: `Ask a human to run \`argo template create <file>\`. ${ROADMAP}`,
  },
  "template update": {
    reason: "WorkflowTemplate writes are not in this release",
    alternative: `Ask a human to run \`argo template update <file>\`. ${ROADMAP}`,
  },
  "template delete": {
    reason: "WorkflowTemplate writes are not in this release",
    alternative: `Ask a human to run \`argo template delete <name>\`. ${ROADMAP}`,
  },
  "clustertemplate create": {
    reason: "ClusterWorkflowTemplate writes are not in this release",
    alternative: `Ask a human to run \`argo cluster-template create <file>\`. ${ROADMAP}`,
  },
  "clustertemplate update": {
    reason: "ClusterWorkflowTemplate writes are not in this release",
    alternative: `Ask a human to run \`argo cluster-template update <file>\`. ${ROADMAP}`,
  },
  "clustertemplate delete": {
    reason: "ClusterWorkflowTemplate writes are not in this release",
    alternative: `Ask a human to run \`argo cluster-template delete <name>\`. ${ROADMAP}`,
  },
  "archive delete": {
    reason: "Archive writes are not in this release",
    alternative: `Ask a human to run \`argo archive delete <uid>\`. ${ROADMAP}`,
  },
  "archive retry": {
    reason: "Archive writes are not in this release",
    alternative: `Ask a human to run \`argo archive retry <uid>\`. ${ROADMAP}`,
  },
  "archive resubmit": {
    reason: "Archive writes are not in this release",
    alternative: `Ask a human to run \`argo archive resubmit <uid>\`. ${ROADMAP}`,
  },
};
