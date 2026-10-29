/**
 * Sensitive-data redaction (design S12, option a): values whose key looks
 * sensitive are replaced, the number of redacted fields is reported, and there
 * is no reveal flag. Free-text (log lines, messages) gets best-effort masking
 * of `key=value` / `key: value` pairs, bearer tokens and private key blocks.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth(?!or(?!i[sz]ation))|bearer|session|cookie|signature|dsn|connection[-_]?string|client[-_]?key|ssh[-_]?key|cert(ificate)?[-_]?key)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

const PAIR_VALUE_KEYS = ["value", "default"];

export interface Redacted<T> {
  value: T;
  count: number;
}

/**
 * Deep-copy `input`, redacting:
 * - object properties whose key looks sensitive (scalar values only);
 * - `{ name, value }` / `{ name, default }` pairs (parameters, env vars) whose name looks sensitive;
 * - free-text strings via `redactText`.
 */
export function redactValue<T>(input: T): Redacted<T> {
  let count = 0;

  const walk = (node: unknown, parentKey?: string): unknown => {
    if (typeof node === "string") {
      if (parentKey !== undefined && isSensitiveKey(parentKey)) {
        count += 1;
        return REDACTED;
      }
      const text = redactText(node);
      count += text.count;
      return text.text;
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (node === null || typeof node !== "object") {
      if (
        parentKey !== undefined &&
        isSensitiveKey(parentKey) &&
        (typeof node === "number" || typeof node === "boolean")
      ) {
        count += 1;
        return REDACTED;
      }
      return node;
    }

    const record = node as Record<string, unknown>;
    const pairName =
      typeof record.name === "string" &&
      PAIR_VALUE_KEYS.some((k) => k in record)
        ? record.name
        : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (
        PAIR_VALUE_KEYS.includes(key) &&
        pairName !== undefined &&
        isSensitiveKey(pairName) &&
        child !== undefined &&
        child !== null &&
        child !== ""
      ) {
        count += 1;
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(child, key);
    }
    return out;
  };

  const value = walk(input) as T;
  return { value, count };
}

const PAIR_PATTERN =
  /(["']?)([A-Za-z0-9_.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth(?!or(?!i[sz]ation))|bearer|session|cookie|signature|dsn)[A-Za-z0-9_.-]*)\1(\s*[=:]\s*)(["']?)([^\s"',;&]+)\4/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** Best-effort masking for free text. Cannot catch every secret in a log body. */
export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text.replace(PRIVATE_KEY_PATTERN, () => {
    count += 1;
    return `-----${REDACTED} PRIVATE KEY-----`;
  });
  out = out.replace(BEARER_PATTERN, (_m, scheme: string) => {
    count += 1;
    return `${scheme} ${REDACTED}`;
  });
  out = out.replace(
    PAIR_PATTERN,
    (match, q1: string, key: string, sep: string, q2: string, val: string) => {
      if (val === REDACTED || val.startsWith("[redacted")) {
        return match;
      }
      count += 1;
      return `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}`;
    },
  );
  return { text: out, count };
}
