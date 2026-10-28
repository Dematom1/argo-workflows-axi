import { AxiError } from "axi-sdk-js";

/**
 * A command's declared flags. Every flag is validated before any dependency
 * call; anything undeclared is rejected by name with the valid set inlined.
 */
export interface FlagSpec {
  /** Flags that take a value, keyed by long name (e.g. `--status`). */
  value?: string[];
  /** Value flags that may repeat (e.g. `--parameter`). */
  repeatable?: string[];
  /** Boolean flags. */
  bool?: string[];
  /** Short aliases, e.g. `{ "-n": "--namespace" }`. */
  aliases?: Record<string, string>;
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  bools: Set<string>;
}

/** Target flags shared by every command that talks to Argo (argo's own names). */
export const TARGET_FLAGS: FlagSpec = {
  value: ["--context", "--argo-server", "--namespace"],
  aliases: { "-s": "--argo-server", "-n": "--namespace" },
};

export const ALL_NAMESPACES_FLAG: FlagSpec = {
  bool: ["--all-namespaces"],
  aliases: { "-A": "--all-namespaces" },
};

export function mergeSpecs(...specs: FlagSpec[]): FlagSpec {
  const merged: Required<FlagSpec> = {
    value: [],
    repeatable: [],
    bool: [],
    aliases: {},
  };
  for (const spec of specs) {
    merged.value.push(...(spec.value ?? []));
    merged.repeatable.push(...(spec.repeatable ?? []));
    merged.bool.push(...(spec.bool ?? []));
    Object.assign(merged.aliases, spec.aliases ?? {});
  }
  return merged;
}

function describeFlags(spec: FlagSpec): string {
  const reverse = new Map<string, string>();
  for (const [short, long] of Object.entries(spec.aliases ?? {})) {
    reverse.set(long, short);
  }
  const names = [
    ...(spec.value ?? []),
    ...(spec.repeatable ?? []),
    ...(spec.bool ?? []),
  ].map((name) => (reverse.has(name) ? `${reverse.get(name)}/${name}` : name));
  return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * Parse argv against a spec. Supports `--flag value`, `--flag=value` and
 * short aliases. `--help` never reaches here (the SDK answers it first).
 */
export function parseArgs(
  argv: string[],
  spec: FlagSpec,
  usage: string,
): ParsedArgs {
  const valueFlags = new Set([
    ...(spec.value ?? []),
    ...(spec.repeatable ?? []),
  ]);
  const repeatable = new Set(spec.repeatable ?? []);
  const boolFlags = new Set(spec.bool ?? []);
  const aliases = spec.aliases ?? {};
  const parsed: ParsedArgs = {
    positionals: [],
    values: new Map(),
    bools: new Set(),
  };

  const fail = (message: string): never => {
    throw new AxiError(message, "VALIDATION_ERROR", [
      `Valid flags for \`${usage}\`: ${describeFlags(spec)} (--help always allowed)`,
    ]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-" || !token.startsWith("-")) {
      parsed.positionals.push(token);
      continue;
    }
    if (token === "--") {
      fail("`--` is not supported; pass names as plain arguments");
    }

    const eq = token.indexOf("=");
    const rawName = eq === -1 ? token : token.slice(0, eq);
    const name = aliases[rawName] ?? rawName;
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    if (boolFlags.has(name)) {
      if (inlineValue !== undefined) {
        fail(`${rawName} does not take a value`);
      }
      parsed.bools.add(name);
      continue;
    }

    if (valueFlags.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          fail(`${rawName} requires a value`);
        }
        value = next;
        i += 1;
      }
      const existing = parsed.values.get(name);
      if (existing && !repeatable.has(name)) {
        fail(`${rawName} was given more than once`);
      }
      parsed.values.set(name, [...(existing ?? []), value as string]);
      continue;
    }

    fail(`Unknown flag ${rawName} for \`${usage}\``);
  }

  return parsed;
}

export function flagValue(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  return parsed.values.get(name)?.[0];
}

export function flagValues(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.bools.has(name);
}

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** Validate a Kubernetes object name before it reaches any dependency call. */
export function assertName(value: string, what: string, usage: string): void {
  if (value.length > 253 || !K8S_NAME.test(value)) {
    throw new AxiError(
      `Invalid ${what} name: ${JSON.stringify(value)}`,
      "VALIDATION_ERROR",
      [
        `Names are lowercase letters, digits, '-' and '.' (Kubernetes object names). Run \`${usage}\``,
      ],
    );
  }
}

export function requirePositionals(
  parsed: ParsedArgs,
  min: number,
  max: number,
  usage: string,
): string[] {
  const { positionals } = parsed;
  if (positionals.length < min) {
    throw new AxiError("Missing required argument", "VALIDATION_ERROR", [
      `Run \`${usage}\``,
    ]);
  }
  if (positionals.length > max) {
    throw new AxiError(
      `Unexpected argument: ${positionals[max]}`,
      "VALIDATION_ERROR",
      [`Run \`${usage}\``],
    );
  }
  return positionals;
}

const DURATION = /^(\d+)(s|m|h|d)$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parse `90s`, `5m`, `2h`, `1d` into seconds. */
export function parseDuration(value: string, flag: string): number {
  const match = DURATION.exec(value);
  if (!match) {
    throw new AxiError(
      `${flag} must be a duration like 90s, 5m, 2h or 1d (got ${JSON.stringify(value)})`,
      "VALIDATION_ERROR",
    );
  }
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

export function parsePositiveInt(
  value: string,
  flag: string,
  max: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new AxiError(
      `${flag} must be a whole number (got ${JSON.stringify(value)})`,
      "VALIDATION_ERROR",
    );
  }
  const n = Number(value);
  if (n < 1 || n > max) {
    throw new AxiError(
      `${flag} must be between 1 and ${max} (got ${n})`,
      "VALIDATION_ERROR",
    );
  }
  return n;
}
