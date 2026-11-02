// Synthetic HTTP protocol lab: packed wrapper + real argo CLI, NOT a cluster.
// Usage: node test/native-write-lab.mjs <installed-package-dir> <absolute-argo-bin>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const [packageDir, argoBin] = process.argv.slice(2);
assert(
  packageDir && argoBin?.startsWith("/"),
  "provide installed package and absolute real argo path",
);
const require = createRequire(join(resolve(packageDir), "package.json"));
const { decode } = require("@toon-format/toon");
const manifest = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
const bin = join(packageDir, manifest.bin["argo-workflows-axi"]);
const root = mkdtempSync(join(tmpdir(), "awf-native-write-lab-"));
const path = join(root, "bin");
mkdirSync(path);
symlinkSync(argoBin, join(path, "argo"));
symlinkSync(process.execPath, join(path, "node"));
let phase = "Running";
let stallName;
let requests = [];
const workflow = (name) => ({
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Workflow",
  metadata: { name, namespace: "argo", uid: `uid-${name}` },
  spec: {
    suspend: phase === "Suspended" || name === "already-suspended",
    entrypoint: "main",
    templates: [{ name: "main", container: { image: "fixture-only" } }],
  },
  status: { phase },
});
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, body });
  if (req.method !== "GET" && req.url.includes(`/${stallName}/`)) return;
  if (req.method !== "GET" && req.url.includes("/denied/")) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: 7,
        message: "fixture permission denied: forbidden",
      }),
    );
    return;
  }
  res.setHeader("content-type", "application/json");
  const parts = req.url.split("?")[0].split("/");
  const name = parts[5];
  if (req.method === "GET" && name?.includes("-rs-")) {
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 5, message: "workflow not found" }));
  } else if (req.url.includes("workflow-templates")) {
    res.end(JSON.stringify({ ...workflow(name), kind: "WorkflowTemplate" }));
  } else if (req.url.includes("cron-workflows")) {
    res.end(
      JSON.stringify({
        ...workflow(name),
        kind: "CronWorkflow",
        spec: { suspend: phase === "Suspended", schedule: "* * * * *" },
      }),
    );
  } else if (req.method !== "GET" && parts.at(-1) === "resubmit") {
    res.end(JSON.stringify(workflow("memoized-copy")));
  } else if (
    req.method === "POST" &&
    (parts.at(-1) === "argo" || parts.at(-1) === "submit")
  ) {
    const input = JSON.parse(body);
    res.end(
      JSON.stringify(
        workflow(
          input.workflow?.metadata?.name ??
            input.submitOptions?.name ??
            "submitted-copy",
        ),
      ),
    );
  } else {
    res.end(JSON.stringify(workflow(name)));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = `127.0.0.1:${server.address().port}`;
let sequence = 0;
async function run(args, { openStdin = false, reuseHome } = {}) {
  const home = reuseHome ?? join(root, `home-${sequence++}`);
  const configHome = join(home, ".config");
  mkdirSync(join(configHome, "argo-workflows-axi"), { recursive: true });
  writeFileSync(
    join(configHome, "argo-workflows-axi", "config.json"),
    JSON.stringify({
      writableTargets: [{ server: address, namespace: "argo" }],
    }),
  );
  requests = [];
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: root,
    env: {
      PATH: path,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      KUBECONFIG: join(home, "absent"),
      ARGO_HTTP1: "true",
      ARGO_SECURE: "false",
      ARGO_TOKEN: "fixture-only",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  if (!openStdin) child.stdin.end();
  const guard = setTimeout(() => child.kill("SIGKILL"), 15000);
  const exit = await new Promise((done) => child.on("close", done));
  clearTimeout(guard);
  const result = { args, exit, stdout, stderr, home, requests: [...requests] };
  console.log(JSON.stringify(result));
  return { ...result, output: decode(stdout) };
}
const target = ["--argo-server", address, "-n", "argo", "--apply"];
try {
  for (const [noun, verb] of [
    ["wf", "suspend"],
    ["wf", "resume"],
    ["wf", "retry"],
    ["wf", "stop"],
    ["wf", "terminate"],
    ["cron", "suspend"],
    ["cron", "resume"],
  ]) {
    phase =
      verb === "retry" ? "Failed" : verb === "resume" ? "Suspended" : "Running";
    const result = await run([noun, verb, "source", ...target]);
    assert.equal(result.exit, 0, result.stdout);
    assert.equal(result.output.results[0].status, "accepted");
    const mutation = result.requests.findIndex((r) => r.method !== "GET");
    assert(mutation >= 0, "real native mutation must reach the stub");
    assert.equal(
      result.requests.slice(mutation + 1).length,
      0,
      "no post-write read or wait",
    );
    assert.match(result.stderr, /overall deadline/);
    assert(!result.stdout.includes("elapsed"));
  }
  phase = "Failed";
  for (const extra of [[], ["--memoized", "--new"]]) {
    const result = await run(["wf", "resubmit", "source", ...extra, ...target]);
    assert.equal(result.exit, 0, result.stdout);
    assert.equal(result.output.results[0].status, "accepted");
    assert(!result.requests.some((r) => /watch/i.test(r.url)));
  }
  phase = "Running";
  const submitted = await run([
    "wf",
    "submit",
    "--from",
    "workflowtemplate/source",
    ...target,
  ]);
  assert.equal(submitted.exit, 0, submitted.stdout);
  assert.equal(submitted.output.status, "accepted");
  assert.match(submitted.stdout, /wf wait/);
  stallName = "b";
  const batch = await run([
    "wf",
    "suspend",
    "a",
    "denied",
    "b",
    "c",
    ...target,
    "--timeout",
    "6s",
  ]);
  assert.equal(batch.exit, 1);
  assert.deepEqual(
    batch.output.results.map((r) => [r.name, r.status]),
    [
      ["a", "accepted"],
      ["denied", "failed"],
      ["b", "unknown"],
      ["c", "not_attempted"],
    ],
  );
  assert(
    !batch.requests.some((r) => r.method !== "GET" && r.url.includes("/c/")),
  );
  assert.match(batch.stderr, /5s elapsed/);
  stallName = "needs-suspension";
  const expiredNoop = await run([
    "wf", "suspend", "needs-suspension", "already-suspended", ...target,
    "--timeout", "1s",
  ]);
  assert.equal(expiredNoop.exit, 1);
  assert.deepEqual(
    expiredNoop.output.results.map((r) => [r.name, r.status]),
    [["needs-suspension", "unknown"], ["already-suspended", "no_op"]],
  );
  assert(
    !expiredNoop.requests.some(
      (r) => r.method !== "GET" && r.url.includes("/already-suspended/"),
    ),
    "planned no-op must not send a mutation after deadline expiry",
  );
  stallName = undefined;
  const stdin = await run(["wf", "submit", "-", ...target, "--timeout", "1s"], {
    openStdin: true,
  });
  assert.equal(stdin.exit, 1);
  assert.equal(stdin.output.code, "TIMEOUT");
  assert.equal(stdin.requests.length, 0);
  assert.notEqual(process.getuid?.(), 0, "permission proof must run non-root");
  const installed = await run(["setup", "hooks"]);
  assert.equal(installed.exit, 0);
  const codex = join(installed.home, ".codex", "hooks.json");
  chmodSync(codex, 0o400);
  try {
    const denied = await run(["setup", "uninstall"], {
      reuseHome: installed.home,
    });
    assert.equal(denied.exit, 1);
    assert.equal(denied.output.code, "SETUP_FAILED");
    assert.match(readFileSync(codex, "utf8"), /argo-workflows-axi/);
  } finally {
    chmodSync(codex, 0o600);
  }
  const removed = await run(["setup", "uninstall"], {
    reuseHome: installed.home,
  });
  assert.equal(removed.exit, 0);
  assert.equal(removed.output.session_end, "absent");
  assert(!readFileSync(codex, "utf8").includes("argo-workflows-axi"));
  const settings = join(installed.home, ".claude", "settings.json");
  assert(!readFileSync(settings, "utf8").includes("# argo-workflows-axi"));
  chmodSync(settings, 0o000);
  try {
    const unreadable = await run(["setup", "uninstall"], {
      reuseHome: installed.home,
    });
    assert.equal(unreadable.exit, 1);
    assert.equal(unreadable.output.code, "FILE_ERROR");
  } finally {
    chmodSync(settings, 0o600);
  }
  console.log(
    "PASS: packed wrapper + real argo against loopback synthetic HTTP stub, plus local setup permission checks; no real cluster",
  );
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
