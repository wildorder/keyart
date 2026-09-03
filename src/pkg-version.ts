import { readFileSync } from "node:fs";

/**
 * The package's own version, read from package.json at module load — the
 * SINGLE source of truth, so `npm version <type>` + `git push --follow-tags`
 * is the whole release ritual (no hard-coded copies to sync). This module
 * sits directly under src/ (compiled to dist/), so `../package.json` resolves
 * to the package root from BOTH the source tree (tests) and dist (shipped).
 */
export const PACKAGE_VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ) as { version: string }
).version;
