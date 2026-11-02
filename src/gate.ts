import { hasFlag, type ParsedArgs } from "./args.js";
import { mintApproval, type WriteApproval } from "./approval.js";
import { displayConfigPath, isWritable, loadConfig } from "./config.js";
import { axiError, errorMessage } from "./errors.js";
import { shellQuote } from "./format.js";
import type { WriteOperationId } from "./registry.js";
import { envServer, type Target } from "./target.js";

/**
 * The write gate (design S3 + S8):
 * - without `--apply` every write is a preview: nothing is sent;
 * - `--apply` needs a writable target (explicit or uniquely defaulted) and
 *   never accepts `-A`;
 * - the target must be in the local allowlist file (default: none).
 * Only this module mints the approval the seam requires for a write.
 */

export const APPLY_FLAG = "--apply";

/** Resolve an omitted write target only when the allowlist has one match. */
export function resolveWriteTarget(target: Target): Target {
  if (
    envServer() &&
    target.mode === "argo-server" &&
    !target.explicit.server &&
    (target.explicit.context || target.explicit.namespace)
  ) {
    throw axiError(
      "A Kubernetes context or namespace cannot be combined with ARGO_SERVER",
      "VALIDATION_ERROR",
      ["Pass --argo-server to target Argo Server explicitly"],
    );
  }
  if (
    target.explicit.namespace &&
    (target.explicit.context || target.explicit.server)
  )
    return target;
  const configured = loadConfig().writableTargets;
  const hasExplicitTarget =
    target.explicit.context ||
    target.explicit.server ||
    target.explicit.namespace;
  const targets = configured.filter((entry) => {
    if (target.explicit.server && entry.server !== target.server) return false;
    if (target.explicit.context && entry.context !== target.context)
      return false;
    if (
      target.explicit.namespace &&
      entry.namespace !== "*" &&
      entry.namespace !== target.namespace
    )
      return false;
    return true;
  });
  if (hasExplicitTarget && targets.length > 1) {
    const inferred = targets.filter(
      (entry) =>
        (target.explicit.context ||
          target.explicit.server ||
          (target.mode === "argo-server"
            ? entry.server !== undefined && entry.server === target.server
            : entry.context !== undefined &&
              entry.context === target.context)) &&
        (target.explicit.namespace ||
          entry.namespace === "*" ||
          entry.namespace === target.namespace),
    );
    if (inferred.length === 1) targets.splice(0, targets.length, inferred[0]);
  }
  if (targets.length !== 1) {
    const list = targets.length
      ? targets
          .map(
            (t) =>
              `  ${t.context ? `context=${t.context}` : `server=${t.server}`} namespace=${t.namespace}`,
          )
          .join("\n")
      : "  (none)";
    throw axiError(
      `Cannot determine a writable target (${targets.length} matching):\n${list}`,
      "VALIDATION_ERROR",
      ["Pass --context <context> and -n <namespace> explicitly"],
    );
  }
  const chosen = targets[0];
  if (chosen.namespace === "*" && !target.explicit.namespace) {
    throw axiError(
      "The matching writable target allows any namespace; the namespace cannot be defaulted",
      "VALIDATION_ERROR",
      ["Pass -n <namespace> explicitly"],
    );
  }
  if (envServer() && !chosen.server) {
    throw axiError(
      `Cannot default to a Kubernetes target while ARGO_SERVER is set: ARGO_SERVER=${envServer()} conflicts with context=${chosen.context} namespace=${chosen.namespace}`,
      "VALIDATION_ERROR",
      ["Unset ARGO_SERVER to use the Kubernetes target"],
    );
  }
  return {
    ...target,
    mode: chosen.server ? "argo-server" : "kubernetes",
    server: chosen.server,
    context: chosen.context,
    namespace:
      target.explicit.namespace || chosen.namespace === "*"
        ? target.namespace
        : chosen.namespace,
    namespaceSource: target.explicit.namespace
      ? target.namespaceSource
      : "default",
    defaulted: true,
  };
}

export interface GateDecision {
  apply: boolean;
  /** `yes`, or `no - <why>`. */
  writable: string;
  /** Exact command that runs the previewed write. */
  run: string;
  approval?: WriteApproval;
}

/** Target flags spelled out with the resolved values. */
export function explicitTargetFlags(target: Target): string {
  const where =
    target.mode === "argo-server"
      ? `--argo-server ${shellQuote(target.server ?? "<host:port>")}`
      : `--context ${shellQuote(target.context ?? "<context>")}`;
  return `${where} -n ${shellQuote(target.namespace)}`;
}

function writableStatus(target: Target): { ok: boolean; text: string } {
  try {
    const config = loadConfig();
    if (isWritable(config, target)) {
      return { ok: true, text: "yes" };
    }
    return {
      ok: false,
      text: `no - this target is not in ${displayConfigPath()}`,
    };
  } catch (error) {
    return { ok: false, text: `no - ${errorMessage(error)}` };
  }
}

function allowlistEntry(target: Target): string {
  return target.mode === "argo-server"
    ? `{"server":"${target.server}","namespace":"${target.namespace}"}`
    : `{"context":"${target.context ?? "<context>"}","namespace":"${target.namespace}"}`;
}

export function checkWrite(
  op: WriteOperationId,
  parsed: ParsedArgs,
  target: Target,
  /** The command as typed, without target flags or `--apply` (already shell-quoted). */
  command: string,
): GateDecision {
  if (target.allNamespaces) {
    throw axiError(
      "Writes never accept -A/--all-namespaces",
      "VALIDATION_ERROR",
      ["Pass one namespace with `-n <namespace>`"],
    );
  }

  const run = `argo-workflows-axi ${command} ${explicitTargetFlags(target)} ${APPLY_FLAG}`;
  const apply = hasFlag(parsed, APPLY_FLAG);
  const writable = writableStatus(target);

  if (!apply) {
    return { apply, writable: writable.text, run };
  }

  const missing: string[] = [];
  if (!target.explicit.namespace && !target.defaulted)
    missing.push("-n/--namespace");
  if (target.mode === "argo-server") {
    if (!target.explicit.server && !target.defaulted) {
      missing.push(
        envServer()
          ? "--argo-server (ARGO_SERVER is set, so argo talks to that server)"
          : "--argo-server",
      );
    }
  } else if (!target.explicit.context && !target.defaulted) {
    missing.push("--context");
  }
  if (missing.length > 0) {
    throw axiError(
      `--apply needs an explicit target: missing ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      [`Run \`${run}\` after checking the target is the one you mean`],
    );
  }

  if (!writable.ok) {
    throw axiError(
      `Writes are not allowed on ${target.mode === "argo-server" ? `server ${target.server}` : `context ${target.context}`} namespace ${target.namespace}: ${writable.text.replace(/^no - /, "")}`,
      "REFUSED",
      [
        `Ask the user to add ${allowlistEntry(target)} to "writableTargets" in ${displayConfigPath()} if writes there are intended`,
      ],
    );
  }

  return { apply, writable: writable.text, run, approval: mintApproval(op) };
}
