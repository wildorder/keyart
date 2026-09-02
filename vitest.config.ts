import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest's 5000ms default is a poor fit for this suite: dozens of cases
    // drive real filesystem work (mkdtemp + a full codify/pack write + rm -rf)
    // across many parallel workers, so a case that takes ~400ms in isolation
    // can take 10x that under full-suite contention — failing as a TIMEOUT
    // whose assertions never ran, on a different test each run. Raising the
    // default removes that false-negative class without weakening a single
    // assertion; a genuinely hung test still fails, just honestly.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
