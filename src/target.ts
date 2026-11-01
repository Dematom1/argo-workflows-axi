import { flagValue, hasFlag, type ParsedArgs } from "./args.js";
import { errorMessage } from "./errors.js";
import { runRead, type TargetArgs } from "./seam.js";
import { shellQuote } from "./format.js";

/**
 * Where a command lands (design S8). Resolved offline: flags, then ARGO_*
 * environment variables, then `kubectl config` (local file reads only, never
 * the network). Credentials are never read.
 */
export type Mode = "kubernetes" | "argo-server";

export interface Target {
  mode: Mode;
  /** Kubernetes context (Kubernetes-API mode). */
  context?: string;
  /** `host:port` of the Argo Server (Argo Server mode). */
  server?: string;
  namespace: string;
  namespaceSource: "flag" | "ARGO_NAMESPACE" | "kubeconfig" | "default";
  allNamespaces: boolean;
  explicit: { context: boolean; server: boolean; namespace: boolean };
  /** Why the context could not be resolved, when it could not. */
  contextUnavailable?: string;
  defaulted?: boolean;
}

export function targetArgsFrom(parsed: ParsedArgs): TargetArgs {
  return {
    context: flagValue(parsed, "--context"),
    server: flagValue(parsed, "--argo-server"),
    namespace: flagValue(parsed, "--namespace"),
  };
}

export function envServer(): string | undefined {
  const value = process.env.ARGO_SERVER?.trim();
  return value ? value : undefined;
}

// Local kubeconfig reads only; bounded so a broken exec plugin cannot hang a session.
const LOCAL_TIMEOUT_MS = 8_000;

async function currentContext(): Promise<string> {
  const { stdout } = await runRead("local.kube-current-context", [], {
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function contextNamespace(context?: string): Promise<string | undefined> {
  const args = [
    "--minify",
    "--output=jsonpath={.contexts[0].context.namespace}",
  ];
  if (context) args.push(`--context=${context}`);
  const { stdout } = await runRead("local.kube-context-namespace", args, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  const ns = stdout.trim();
  return ns ? ns : undefined;
}

export async function resolveTarget(parsed: ParsedArgs): Promise<Target> {
  const args = targetArgsFrom(parsed);
  const server = args.server ?? envServer();
  const mode: Mode = server ? "argo-server" : "kubernetes";
  const target: Target = {
    mode,
    server,
    namespace: "default",
    namespaceSource: "default",
    allNamespaces: hasFlag(parsed, "--all-namespaces"),
    explicit: {
      context: args.context !== undefined,
      server: args.server !== undefined,
      namespace: args.namespace !== undefined,
    },
  };

  // Context and namespace lookups are independent local reads: run them together.
  // Settle both before awaiting either, so a rejection never goes unhandled.
  const [contextLookup, namespaceLookup] = await Promise.allSettled([
    !args.context && mode === "kubernetes" ? currentContext() : undefined,
    !args.namespace && !process.env.ARGO_NAMESPACE
      ? contextNamespace(args.context)
      : undefined,
  ]);

  if (args.context) {
    target.context = args.context;
  } else if (contextLookup.status === "fulfilled") {
    target.context = contextLookup.value;
  } else {
    target.contextUnavailable = errorMessage(contextLookup.reason);
  }

  if (args.namespace) {
    target.namespace = args.namespace;
    target.namespaceSource = "flag";
  } else if (process.env.ARGO_NAMESPACE) {
    target.namespace = process.env.ARGO_NAMESPACE;
    target.namespaceSource = "ARGO_NAMESPACE";
  } else if (namespaceLookup.status === "fulfilled" && namespaceLookup.value) {
    target.namespace = namespaceLookup.value;
    target.namespaceSource = "kubeconfig";
  }
  // Otherwise the namespace falls back to "default", like argo itself.

  return target;
}

/** One-line description, e.g. `kubernetes context=kind-dev namespace=argo`. */
export function describeTarget(target: Target): string {
  const where =
    target.mode === "argo-server"
      ? `server=${target.server}`
      : `context=${target.context ?? "unavailable"}`;
  const ns = target.allNamespaces
    ? "namespace=(all)"
    : `namespace=${target.namespace}`;
  return `${target.mode} ${where} ${ns}`;
}

/** Target flags to forward to argo so it lands exactly where we resolved. */
export function forwardTarget(parsed: ParsedArgs): TargetArgs {
  const args = targetArgsFrom(parsed);
  return hasFlag(parsed, "--all-namespaces")
    ? { context: args.context, server: args.server }
    : args;
}

/** Carry disambiguating flags into suggested follow-up commands (AXI principle 9). */
export function targetSuffix(parsed: ParsedArgs): string {
  const args = targetArgsFrom(parsed);
  const parts: string[] = [];
  if (args.context) parts.push(`--context ${shellQuote(args.context)}`);
  if (args.server) parts.push(`--argo-server ${shellQuote(args.server)}`);
  if (args.namespace) parts.push(`-n ${shellQuote(args.namespace)}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
