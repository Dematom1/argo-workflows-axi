import { TARGET_FLAGS, parseArgs } from "../args.js";
import { displayConfigPath, isWritable, loadConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import { runRead } from "../seam.js";
import { describeTarget, resolveTarget } from "../target.js";
import { lastSession } from "../sessions.js";

/**
 * Offline context view (design S17): resolved mode, context or server,
 * namespace, argo CLI version and whether writes are allowed here. No network,
 * no credentials, no SSO refresh. Powers the session-start hook.
 */

export const SUPPORTED_RANGE = {
  min: "3.7.0",
  maxExclusive: "4.2.0",
  label: "v3.7 through v4.1",
};

export const CTX_HELP = `command: argo-workflows-axi ctx
description: Offline view of where commands land - mode, context or server, namespace, argo CLI version, writable or not. Never touches the network.
flags:
  --context <name>: Kubernetes context to describe
  -s, --argo-server <host:port>: Argo Server to describe
  -n, --namespace <ns>: Namespace to describe
examples[2]:

  - argo-workflows-axi ctx
  - argo-workflows-axi ctx --context kind-dev -n argo
`;

function parseVersion(text: string): string | undefined {
  return /v?(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function versionSupport(version: string): string {
  if (
    compare(version, SUPPORTED_RANGE.min) < 0 ||
    compare(version, SUPPORTED_RANGE.maxExclusive) >= 0
  ) {
    return `outside the supported range (${SUPPORTED_RANGE.label}); output shapes may differ`;
  }
  return "supported";
}

/** Local argo client version; ARGO_SERVER is unset for the call so argo stays offline. */
export async function argoClientVersion(): Promise<{
  version?: string;
  note: string;
}> {
  try {
    const { stdout } = await runRead("local.version", ["--short"], {
      timeoutMs: 8_000,
      unsetEnv: ["ARGO_SERVER"],
    });
    const version = parseVersion(stdout);
    if (!version)
      return { note: "unavailable - could not read the argo version" };
    return { version, note: versionSupport(version) };
  } catch (error) {
    return { note: `unavailable - ${errorMessage(error)}` };
  }
}

export async function ctxCommand(
  args: string[],
): Promise<Record<string, unknown> | string> {
  if (args.includes("--help")) return CTX_HELP;
  const parsed = parseArgs(args, TARGET_FLAGS, "argo-workflows-axi ctx");
  return ctxView(parsed);
}

export async function ctxView(
  parsed: ReturnType<typeof parseArgs>,
): Promise<Record<string, unknown>> {
  const [target, version] = await Promise.all([
    resolveTarget(parsed),
    argoClientVersion(),
  ]);

  let writable: string;
  let writableTargets: number | string;
  try {
    const config = loadConfig();
    writableTargets = config.writableTargets.length;
    writable = isWritable(config, target)
      ? "yes"
      : `no - not in ${displayConfigPath()}`;
  } catch (error) {
    writableTargets = "unavailable";
    writable = `no - ${errorMessage(error)}`;
  }

  const out: Record<string, unknown> = {
    target: describeTarget(target),
    mode: target.mode,
  };
  if (target.mode === "argo-server") {
    out.server = target.server;
    out.archive = "available (Argo Server mode)";
  } else {
    out.context =
      target.context ??
      `unavailable - ${target.contextUnavailable ?? "no current context"}`;
    out.archive = "unsupported in Kubernetes-API mode";
  }
  out.namespace = `${target.namespace} (from ${target.namespaceSource})`;
  out.argo = version.version
    ? `v${version.version} - ${version.note}`
    : version.note;
  out.writable = writable;
  out.writable_targets = writableTargets;
  const session = lastSession();
  if (session) {
    out.last_session = {
      commands: session.commands,
      ...(session.target ? { target: session.target } : {}),
      ...(session.namespace ? { namespace: session.namespace } : {}),
      ended_at: session.ended_at,
    };
  }
  out.help = [
    "Run `argo-workflows-axi` for live workflow state, or `argo-workflows-axi triage` for what is broken",
  ];
  return out;
}
