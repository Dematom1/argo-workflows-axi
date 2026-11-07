import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// POSIX signal and process-group fixtures; Windows has no process groups.
describe.skipIf(process.platform === "win32")(
  "packed subprocess deadlines",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "argo-workflows-axi-deadline-"));
    beforeAll(() => {
      const tarball = JSON.parse(
        execFileSync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
          {
            cwd: ROOT,
            encoding: "utf8",
          },
        ),
      );
      execFileSync("tar", ["-xzf", join(dir, tarball[0].filename), "-C", dir]);
      symlinkSync(
        join(ROOT, "node_modules"),
        join(dir, "package/node_modules"),
        "dir",
      );
      writeFileSync(
        join(dir, "argo"),
        `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.PIDS, process.pid + '\\n');
if (['ignore-term', 'windows-fallback'].includes(process.env.MODE)) {
  process.on('SIGTERM', () => {});
} else {
  // A background descendant holding inherited pipes remains in this process group.
  const child = spawn(process.execPath, ['-e', \`
    const fs = require('node:fs');
    fs.appendFileSync(process.env.PIDS, process.pid + '\\\\n');
    setTimeout(() => fs.writeFileSync(process.env.SURVIVED, 'alive'), 2300);
    setTimeout(() => {}, 8000);
  \`], { stdio: ['ignore', 'inherit', 'inherit'], detached: false });
}
writeFileSync(process.env.READY, 'ready');
if (process.env.MODE === 'escaped-pipes') process.exit(0);
setTimeout(() => {}, 8000);
`,
        { mode: 0o755 },
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it.each([
      "grandchild-pipes",
      "ignore-term",
      "escaped-pipes",
      "windows-fallback",
      "SIGINT",
      "SIGTERM",
    ])("terminates promptly with %s", async (mode) => {
      const pids = join(dir, `${mode}.pids`);
      const ready = join(dir, `${mode}.ready`);
      const survived = join(dir, `${mode}.survived`);
      const moduleUrl = pathToFileURL(
        join(dir, "package/dist/src/seam.js"),
      ).href;
      const signal = mode === "SIGINT" || mode === "SIGTERM" ? mode : undefined;
      const started = performance.now();
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { runRead } from ${JSON.stringify(moduleUrl)};
        // Exercise the Windows direct-child fallback with real subprocesses on POSIX.
        if (process.env.MODE === 'windows-fallback') Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
          await runRead('wf.list', [], { timeoutMs: ${signal ? 10000 : 1000} });
          process.exitCode = 1;
        } catch (error) {
          console.log(error.code);
        }
      `,
        ],
        {
          env: {
            PATH: dir,
            HOME: dir,
            MODE: mode,
            PIDS: pids,
            READY: ready,
            SURVIVED: survived,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const completion = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      const descendantsExited = async () => {
        const recorded = readFileSync(pids, "utf8").trim().split("\n");
        expect(recorded).toHaveLength(2);
        for (const pid of recorded) {
          await expect
            .poll(
              () => {
                try {
                  const state = execFileSync("ps", ["-o", "stat=", "-p", pid], {
                    encoding: "utf8",
                  }).trim();
                  return state === "" || state.startsWith("Z");
                } catch (error) {
                  if (
                    error &&
                    typeof error === "object" &&
                    "status" in error &&
                    error.status === 1
                  )
                    return true;
                  throw error;
                }
              },
              { timeout: 1000 },
            )
            .toBe(true);
        }
      };
      try {
        if (signal) {
          await expect
            .poll(
              () =>
                existsSync(ready) &&
                existsSync(pids) &&
                readFileSync(pids, "utf8").trim().split("\n").length ===
                  (signal ? 2 : 1),
              { timeout: 3000 },
            )
            .toBe(true);
          child.kill(signal);
        }
        const code = await completion;
        const elapsed = performance.now() - started;
        expect(existsSync(ready), stdout + stderr).toBe(true);
        if (signal) {
          expect(code).toBe(signal === "SIGINT" ? 130 : 143);
          expect(stdout).toBe("");
          await descendantsExited();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, 2600 - elapsed)),
          );
          expect(existsSync(survived)).toBe(false);
        } else {
          expect(code).toBe(0);
          expect(stdout.trim()).toBe("TIMEOUT");
          expect(elapsed).toBeGreaterThanOrEqual(1000);
          expect(elapsed).toBeLessThan(2500);
        }
        if (mode === "grandchild-pipes" || mode === "escaped-pipes") {
          await descendantsExited();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, 2600 - elapsed)),
          );
          expect(existsSync(survived)).toBe(false);
        }
      } finally {
        child.kill("SIGKILL");
        if (existsSync(pids)) {
          for (const pid of readFileSync(pids, "utf8").trim().split("\n")) {
            try {
              process.kill(Number(pid), "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        }
      }
    });
  },
);
