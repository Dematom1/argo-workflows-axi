import { encode } from "@toon-format/toon";
import { AxiError, exitCodeForError } from "axi-sdk-js";

/**
 * TOON rendering with `help` hints as one line each (the gh-axi layout), so a
 * suggested command is never split by TOON's inline array quoting.
 */

export function renderHelp(lines: string[]): string {
  return lines.length === 0
    ? ""
    : `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

export function render(output: Record<string, unknown> | string): string {
  if (typeof output === "string") return output.replace(/\n+$/, "");
  const { help, ...rest } = output;
  const blocks: string[] = [];
  if (Object.keys(rest).length > 0) blocks.push(encode(rest));
  if (Array.isArray(help)) blocks.push(renderHelp(help.map(String)));
  return blocks.filter(Boolean).join("\n");
}

export function formatError(error: unknown): {
  output: string;
  exitCode: number;
} {
  if (error instanceof AxiError) {
    return {
      output: `${render({ error: error.message, code: error.code, help: error.suggestions })}\n`,
      exitCode: exitCodeForError(error),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${render({ error: message, code: "UNKNOWN" })}\n`,
    exitCode: 1,
  };
}
