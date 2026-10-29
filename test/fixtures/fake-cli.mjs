#!/usr/bin/env node
// Fake `argo` / `kubectl` for tests. Never talks to anything.
//
// FAKE_SCENARIO points at a JSON file:
//   { "responses": [ { "bin": "argo", "match": ["get", "wf-a"], "stdout": "...",
//                      "stderr": "...", "exit": 0, "times": 1, "sleepMs": 0,
//                      "writeFile": ["/path", "contents"] } ] }
// The first response whose `bin` matches and whose `match` tokens all appear in
// argv (and that has uses left) answers. Unmatched calls exit 1 with a
// "fake: no response" message. Every call is appended to FAKE_LOG as JSON,
// with the contents of any absolute-path file arguments.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";

const [bin, ...argv] = process.argv.slice(2);
const scenarioPath = process.env.FAKE_SCENARIO;
const logPath = process.env.FAKE_LOG;

if (logPath) {
  const files = Object.fromEntries(
    argv
      .filter((arg) => arg.startsWith("/") && existsSync(arg))
      .map((arg) => [arg, readFileSync(arg, "utf-8")]),
  );
  appendFileSync(
    logPath,
    `${JSON.stringify({ bin, argv, argoServerEnv: process.env.ARGO_SERVER ?? null, files })}\n`,
  );
}

const scenario = scenarioPath
  ? JSON.parse(readFileSync(scenarioPath, "utf-8"))
  : { responses: [] };
const statePath = scenarioPath ? `${scenarioPath}.state` : undefined;
const used =
  statePath && existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf-8"))
    : {};

const index = scenario.responses.findIndex((r, i) => {
  if ((r.bin ?? "argo") !== bin) return false;
  if (r.times !== undefined && (used[i] ?? 0) >= r.times) return false;
  return (r.match ?? []).every((token) => argv.includes(token));
});

if (index === -1) {
  process.stderr.write(`fake: no response for ${bin} ${argv.join(" ")}\n`);
  process.exit(1);
}

used[index] = (used[index] ?? 0) + 1;
if (statePath) writeFileSync(statePath, JSON.stringify(used));

const response = scenario.responses[index];
if (response.writeFile)
  writeFileSync(response.writeFile[0], response.writeFile[1]);
if (response.sleepMs) {
  await new Promise((resolve) => setTimeout(resolve, response.sleepMs));
}
// Synchronous writes: process.exit() would otherwise cut large output short.
if (response.stdout) writeSync(1, response.stdout);
if (response.stderr) writeSync(2, response.stderr);
process.exit(response.exit ?? 0);
