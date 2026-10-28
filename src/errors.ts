import { AxiError } from "axi-sdk-js";
import { redactText } from "./redact.js";

/**
 * Error codes (design S13): the shared set plus this tool's own.
 * Exit code is 2 for VALIDATION_ERROR and 1 for everything else (SDK rule).
 */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVER_UNREACHABLE"
  | "VALIDATION_ERROR"
  | "REFUSED"
  | "UNSUPPORTED_IN_MODE"
  | "ALREADY_EXISTS"
  | "INVALID_REQUEST"
  | "CONTEXT_NOT_FOUND"
  | "ARGO_NOT_INSTALLED"
  | "CONFIG_INVALID"
  | "TIMEOUT"
  | "UNKNOWN";

export function axiError(
  message: string,
  code: ErrorCode,
  help: string[] = [],
): AxiError {
  return new AxiError(message, code, help);
}

interface Rule {
  test: RegExp;
  code: ErrorCode;
  message: (detail: string) => string;
  help: string[];
}

const RULES: Rule[] = [
  {
    test: /context \\?"[^"\\]*\\?" does not exist|context was not found for specified context|no context exists with the name/i,
    code: "CONTEXT_NOT_FOUND",
    message: (d) => `Kubernetes context not found: ${d}`,
    help: [
      "Run `argo-workflows-axi ctx` to see the current context",
      "Pass `--context <name>` with a context from your kubeconfig",
    ],
  },
  {
    test: /code = Unauthenticated|\bUnauthorized\b|token (has )?expired|you must be logged in|invalid bearer token|unable to load in-cluster configuration|no configuration has been provided/i,
    code: "AUTH_REQUIRED",
    message: (d) => `Not authenticated to Argo Workflows: ${d}`,
    help: [
      "Ask the user to log in (refresh kubeconfig credentials, or set ARGO_TOKEN for an Argo Server); an agent cannot complete SSO",
    ],
  },
  {
    test: /code = PermissionDenied|\bforbidden\b/i,
    code: "FORBIDDEN",
    message: (d) => `Permission denied: ${d}`,
    help: [
      "Ask the user to check the RBAC role bound to this account for workflows.argoproj.io",
    ],
  },
  {
    test: /code = ResourceExhausted|too many requests|rate limit/i,
    code: "RATE_LIMITED",
    message: (d) => `Rate limited: ${d}`,
    help: ["Wait a few seconds and run the command again"],
  },
  {
    test: /code = AlreadyExists|already exists/i,
    code: "ALREADY_EXISTS",
    message: (d) => `Already exists: ${d}`,
    help: [],
  },
  {
    test: /code = NotFound|\bnot found\b/i,
    code: "NOT_FOUND",
    message: (d) => `Not found: ${d}`,
    help: [
      "Run `argo-workflows-axi wf list` to see workflows in this namespace",
      "Pass `-n <namespace>` if the object lives elsewhere",
    ],
  },
  {
    test: /connection refused|no such host|i\/o timeout|context deadline exceeded|code = Unavailable|dial tcp|EOF$|server misbehaving|tls: |x509: |Unable to connect to the server/i,
    code: "SERVER_UNREACHABLE",
    message: (d) => `Cannot reach the cluster or Argo Server: ${d}`,
    help: [
      "Run `argo-workflows-axi ctx` to check which context or server is targeted",
      "Ask the user whether the cluster or Argo Server is up and reachable",
    ],
  },
  {
    test: /not supported in (kubernetes|k8s|offline)|only supported .*argo server|archive.* not supported/i,
    code: "UNSUPPORTED_IN_MODE",
    message: (d) => `Not supported in this mode: ${d}`,
    help: [
      "Set ARGO_SERVER (or pass `--argo-server host:port`) to use Argo Server mode",
    ],
  },
  {
    test: /code = InvalidArgument|code = FailedPrecondition|invalid argument/i,
    code: "INVALID_REQUEST",
    message: (d) => `Argo rejected the request: ${d}`,
    help: [],
  },
];

const NOISE = /^(time="[^"]*"\s+)?level=(debug|info|warn|warning)\b/i;

/** Pull the most informative line out of argo's stderr (logrus or cobra style). */
export function extractDetail(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE.test(line));
  const picked =
    lines.find((line) => /level=(fatal|error)/i.test(line)) ??
    lines.find((line) => line.startsWith("Error:")) ??
    lines[0] ??
    "argo exited without an error message";

  const msg = /msg="((?:[^"\\]|\\.)*)"/.exec(picked);
  let detail = msg ? msg[1].replace(/\\"/g, '"') : picked;
  detail = detail.replace(/^Error:\s*/, "");
  const desc = /desc = (.*)$/.exec(detail);
  if (desc) {
    detail = desc[1];
  }
  return redactText(detail).text.slice(0, 500);
}

/** Translate a failed argo invocation into a structured error. */
export function mapArgoFailure(stderr: string): AxiError {
  const detail = extractDetail(stderr);
  for (const rule of RULES) {
    if (rule.test.test(stderr)) {
      return axiError(rule.message(detail), rule.code, rule.help);
    }
  }
  return axiError(`argo failed: ${detail}`, "UNKNOWN", [
    "Run `argo-workflows-axi ctx` to check the target, then retry",
  ]);
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof AxiError ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
