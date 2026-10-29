import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    testTimeout: 60000,
    // Every test spawns the CLI plus fake argo/kubectl processes; cap
    // concurrency so small CI runners are not oversubscribed.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
