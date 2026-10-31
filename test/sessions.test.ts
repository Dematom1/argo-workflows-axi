import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastSession, recordSession, sessionsPath } from "../src/sessions.js";

const originalConfig = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
});

describe("session memory", () => {
  it("stores only command names, counts, and selected target values", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-session-"));
    process.env.XDG_CONFIG_HOME = root;
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", input: { command: "argo-workflows-axi wf list --context=dev -n argo --token TOP_SECRET" } }] } }));
    recordSession({ transcript_path: transcript, cwd: "/work/project" });
    const contents = readFileSync(sessionsPath(), "utf8");
    expect(contents).not.toContain("TOP_SECRET");
    expect(contents).not.toContain("--token");
    expect(lastSession("/work/project")?.commands).toEqual({ wf: 1 });
    expect(lastSession("/work/project")?.target).toBe("dev");
    expect(lastSession("/work/project")?.namespace).toBe("argo");
    expect(readFileSync(sessionsPath()).length).toBeGreaterThan(0);
  });

  it("tolerates corrupt session files", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-session-"));
    process.env.XDG_CONFIG_HOME = root;
    const path = sessionsPath();
    mkdirSync(join(root, "argo-workflows-axi"));
    writeFileSync(path, "not json");
    chmodSync(path, 0o600);
    expect(lastSession("/work/project")).toBeUndefined();
  });
});
