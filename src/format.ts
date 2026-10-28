/** Small, dependency-free formatting helpers for TOON output. */

export function ageSeconds(
  iso: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? undefined
    : Math.max(0, Math.floor((now - t) / 1000));
}

/** Compact relative age: `45s`, `12m`, `3h`, `5d`. */
export function age(iso: string | undefined, now = Date.now()): string {
  const s = ageSeconds(iso, now);
  if (s === undefined) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Duration between two instants, `1h2m`, `3m10s`, `42s`. Running when `end` is missing. */
export function duration(
  start: string | undefined,
  end: string | undefined,
  now = Date.now(),
): string {
  if (!start) return "";
  const a = Date.parse(start);
  const b = end ? Date.parse(end) : now;
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  let s = Math.max(0, Math.floor((b - a) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export interface Truncated {
  text: string;
  truncated: boolean;
  total: number;
}

/** Keep the head of a long text; report the total size when cut. */
export function truncateHead(text: string, limit: number): Truncated {
  if (text.length <= limit) {
    return { text, truncated: false, total: text.length };
  }
  return {
    text: `${text.slice(0, limit)}... (truncated, ${text.length} chars total)`,
    truncated: true,
    total: text.length,
  };
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Quote a value for a copy-pasteable shell command. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./<>-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
