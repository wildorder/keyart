import { Command } from "commander";
import { runInit, runInitInteractive } from "./commands/init.js";
import { runExplore } from "./commands/explore.js";
import { runRegenerateVisuals } from "./commands/regenerate-visuals.js";
import { runApprove } from "./commands/approve.js";
import { runBrief } from "./commands/brief.js";
import { runAudit } from "./commands/audit.js";
import { PACKAGE_VERSION } from "./pkg-version.js";
import { runServe } from "./commands/serve.js";
import { runMcp } from "./commands/mcp.js";
import { runDoctor } from "./commands/doctor.js";
import {
  runCreateDirection,
  runDirection,
  runDirectionNew,
  runDirectionList,
  runDirectionShow,
  runDirectionFork,
  runRule,
  runPromote,
  DIRECTION_VERBS,
  MEMORY_ACTIONS,
} from "./commands/direction.js";
import { runAsset, type AssetFlags } from "./commands/asset.js";
import { runSurface, type SurfaceFlags } from "./commands/surface.js";
import { CommandError } from "./errors.js";

async function runAction(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CommandError) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

const program = new Command();

program
  .name("keyart")
  .description("A local creative director for AI-built prototypes")
  .version(PACKAGE_VERSION)
  .option("--cwd <dir>", "working directory", process.cwd());

program
  .command("init")
  .description(
    "Scaffold keyart.config.ts and brand/ folder (interactive on a TTY)",
  )
  .option("--force", "Overwrite existing files")
  .option("--yes", "Skip the wizard and scaffold silently with defaults")
  .action(async (cmdOpts: { force?: boolean; yes?: boolean }) => {
    const cwd = program.opts().cwd as string;
    const interactive = !cmdOpts.yes && Boolean(process.stdin.isTTY);
    await runAction(() =>
      interactive
        ? runInitInteractive({ cwd, force: cmdOpts.force })
        : runInit({ cwd, force: cmdOpts.force }),
    );
  });

/**
 * Parse a `--count <n>` option into a positive integer, throwing a CommandError
 * (with usage) when the value is not a positive integer. Returns undefined when
 * the flag was omitted so the callee can apply its own default (explore: 3).
 */
function parseCount(raw: string | undefined, usage: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError(`--count must be a positive integer.\n${usage}`);
  }
  return n;
}

/** Commander collector — accumulates a repeatable option's values into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Validate a `--intent <intent>` flag value (WS-07): the run-wide default intent
 * applied to every `--reference` that lacks its own `:inspire`/`:extract` suffix.
 * Throws a CommandError with usage on anything other than the two literals;
 * returns undefined when the flag was omitted so the per-reference suffix (or,
 * absent that too, `runExplore`'s own `"inspire"` default) still governs.
 */
function parseIntent(
  raw: string | undefined,
  usage: string,
): "inspire" | "extract" | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "inspire" && raw !== "extract") {
    throw new CommandError(`--intent must be "inspire" or "extract".\n${usage}`);
  }
  return raw;
}

/**
 * Parse repeatable `--reference <path[:intent]>` values into run-level references
 * (WS-05). Each spec is a path, optionally suffixed with `:inspire` or `:extract`
 * (only those two literal suffixes are treated as an intent, so a bare path — or
 * a Windows drive path — is never mis-split). A spec without its own suffix falls
 * back to the invocation-wide `defaultIntent` (the `--intent` flag, WS-07) when
 * given; absent both, `runExplore` defaults it to `"inspire"`. Returns undefined
 * when no references were given so ref-less runs stay byte-identical.
 */
function parseReferences(
  raw: string[] | undefined,
  defaultIntent?: "inspire" | "extract",
): { path: string; intent?: "inspire" | "extract" }[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((spec) => {
    for (const intent of ["inspire", "extract"] as const) {
      const suffix = `:${intent}`;
      if (spec.endsWith(suffix)) {
        return { path: spec.slice(0, -suffix.length), intent };
      }
    }
    return defaultIntent ? { path: spec, intent: defaultIntent } : { path: spec };
  });
}

program
  .command("explore [directionId]")
  .description(
    "Generate v1 into an existing draft (explore <directionId>), or mint N new directions from N distinct briefs (--describe/--from)",
  )
  .option("--describe <seed>", "Divergent mode: seed text the N distinct briefs are proposed from")
  .option("--from <directionId>", "Divergent mode: an existing direction whose brief seeds the proposals")
  .option("--count <n>", "Divergent-only: how many directions to mint (default: 3)")
  .option(
    "--instructions <text>",
    "One-shot steering for this run only (not saved to direction memory)",
  )
  .option(
    "--reference <path[:intent]>",
    "Run-level reference image for this run only (repeatable); suffix :inspire (default) or :extract",
    collect,
    [],
  )
  .option(
    "--intent <intent>",
    "Default intent (inspire|extract) applied to every --reference without its own :suffix",
  )
  .action(
    async (
      directionId: string | undefined,
      cmdOpts: {
        describe?: string;
        from?: string;
        count?: string;
        instructions?: string;
        reference?: string[];
        intent?: string;
      },
    ) => {
      const cwd = program.opts().cwd as string;
      const usage =
        'Usage: keyart explore <directionId> | keyart explore --describe "<seed>" [--count <n>] | keyart explore --from <directionId> [--count <n>] — plus [--instructions <text>] [--reference <path[:intent]>] [--intent inspire|extract]';
      await runAction(() => {
        // `--count` is left undefined when omitted so runExplore applies its
        // divergent default of 3; positional mode rejects it with a teaching error.
        const count = parseCount(cmdOpts.count, usage);
        const intent = parseIntent(cmdOpts.intent, usage);
        return runExplore({
          cwd,
          directionId,
          describe: cmdOpts.describe,
          from: cmdOpts.from,
          count,
          instructions: cmdOpts.instructions,
          references: parseReferences(cmdOpts.reference, intent),
        });
      });
    },
  );

program
  .command("regenerate <directionId>")
  .description(
    "Give feedback and regenerate — appends a new version to the direction (never edits its text)",
  )
  .option(
    "--tweak <text>",
    "One-shot art direction appended to the image prompts for this pass only (not saved)",
  )
  .action(
    async (
      directionId: string,
      cmdOpts: { tweak?: string },
    ) => {
      const cwd = program.opts().cwd as string;
      await runAction(() =>
        runRegenerateVisuals({
          cwd,
          directionId,
          tweak: cmdOpts.tweak,
        }),
      );
    },
  );

program
  .command("approve <directionId> [versionId]")
  .description(
    "Approve a direction — pins the current (or a specific) version and codifies the brand",
  )
  .option("--force", "Overwrite existing guide files")
  .action(
    async (
      directionId: string,
      versionId: string | undefined,
      cmdOpts: { force?: boolean },
    ) => {
      const cwd = program.opts().cwd as string;
      await runAction(() =>
        runApprove({
          cwd,
          directionId,
          versionId,
          force: cmdOpts.force,
        }),
      );
    },
  );

program
  .command("brief <pageName>")
  .description("Generate a page implementation brief")
  .option("--force", "Overwrite existing brief")
  .action(async (pageName: string, cmdOpts: { force?: boolean }) => {
    const cwd = program.opts().cwd as string;
    await runAction(() => runBrief({ cwd, pageName, force: cmdOpts.force }));
  });

program
  .command("audit <url>")
  .description("Screenshot and audit a URL against the style guide")
  .action(async (url: string) => {
    const cwd = program.opts().cwd as string;
    await runAction(() => runAudit({ cwd, url }));
  });

program
  .command("serve")
  .description("Start the local studio (browse, author, and approve in the browser)")
  .option("--port <port>", "Port to serve on", "4317")
  .option("--dev", "Run the Vite dev server against src/ui (requires a repo clone)")
  .action(async (cmdOpts: { port: string; dev?: boolean }) => {
    const cwd = program.opts().cwd as string;
    await runAction(() =>
      runServe({ cwd, port: parseInt(cmdOpts.port, 10), dev: cmdOpts.dev === true }),
    );
  });

program
  .command("doctor")
  .description(
    "Report project readiness (config, API key, Playwright, brand scaffold)",
  )
  .action(async () => {
    const cwd = program.opts().cwd as string;
    await runAction(async () => {
      const result = await runDoctor({ cwd });
      if (!result.ok) process.exitCode = 1;
    });
  });

program
  .command("mcp")
  .description("Start the Keyart MCP server (stdio, for coding agents)")
  .action(async () => {
    const cwd = program.opts().cwd as string;
    await runAction(() => runMcp({ cwd }));
  });

/** `rest[0]` of `concept memory <edit|promote|delete> <id> <entryId> …` — the write disambiguation. */
function isMemoryLifecycleAction(word: string | undefined): boolean {
  return word !== undefined && (MEMORY_ACTIONS as readonly string[]).includes(word);
}


program
  .command("direction <verb> [rest...]")
  .description(
    `Work with directions — the whole verb family: ${DIRECTION_VERBS.join(" | ")}. ` +
      "new <name> mints a keyless draft; fork copies brief+moodboard; create '<json>' --from <id> persists agent-authored content at v1; " +
      "memory (read, or edit|promote|delete <id> <entryId>) | brief <show|set|patch|map> | reconcile manage a direction's memory and brief.",
  )
  .option("--describe <text>", "Seed the draft's brief notes (new only; sanitized — soft intent words, never hexes or font families)")
  .option("--name <name>", "Display name (new via positional; fork: fork name, defaults to the source's name)")
  .option("--count <n>", "How many forks to mint (fork only; default: 1)")
  .option("--with-memory", "Also copy the source's active memory log as fresh attributed appends (fork only)")
  .option("--include-archived", "Include archived directions in the listing (direction list only)")
  .option("--from <directionId>", "The REQUIRED seed source for create '<json>' --from <id>; also: fork the brief on new")
  .option("--note <text>", "Record a rejection note as a decision entry (direction reject only)")
  .option("--body <text>", "Memory entry body (direction feedback / direction memory edit)")
  .option("--kind <kind>", "Memory kind: feedback | learning | decision (direction feedback only)")
  .option("--author <author>", "Attribution for memory entries (default: cli)")
  .option("--channel <channel>", "Directive channel: visual | copy | both (direction feedback / direction memory edit)")
  .option("--polarity <polarity>", "Directive polarity: prefer | avoid (direction feedback / direction memory edit)")
  .option("--apply", "Write the proposed patch + hex locks (direction brief map only)")
  .option("--to <scope>", "Promote target: global (direction memory promote only)")
  .option("--reason <text>", "Retirement reason (direction memory delete only)")
  .option("--contradiction <id>", "Contradiction ID to resolve (direction reconcile only)")
  .option("--action <action>", "Reconciliation action: keep | retire | supersede | promote (direction reconcile only)")
  .option("--winner <side>", "Which side wins: subject | conflictsWith (direction reconcile only; default: subject)")
  .option("--severity <severity>", "Severity for promote: guideline | hard (direction reconcile / direction memory promote --to global; default: guideline)")
  .option("--expected-memory-version <n>", "Expected direction memory version for optimistic write (direction reconcile / direction memory edit|promote|delete)", parseInt)
  .option("--expected-global-version <n>", "Expected global brand version for optimistic promote (direction reconcile / direction memory promote --to global)", parseInt)
  .option("--force", "Bypass optimistic version checks")
  .action(
    async (
      verb: string,
      rest: string[],
      cmdOpts: {
        describe?: string;
        name?: string;
        count?: string;
        withMemory?: boolean;
        includeArchived?: boolean;
        from?: string;
        note?: string;
        body?: string;
        kind?: string;
        author?: string;
        channel?: string;
        polarity?: string;
        apply?: boolean;
        to?: string;
        reason?: string;
        contradiction?: string;
        action?: string;
        winner?: string;
        severity?: string;
        expectedMemoryVersion?: number;
        expectedGlobalVersion?: number;
        force?: boolean;
      },
    ) => {
      const cwd = program.opts().cwd as string;
      const forkUsage =
        "Usage: keyart direction fork <id> [--name <name>] [--count N] [--with-memory]";
      // `brief` overloads the trailing positionals into its own shape:
      //   direction brief <subverb> <id> [field] [value…] | <json>
      //   direction brief map <id> <freeform…>
      // `memory <edit|promote|delete> <id> <entryId>` overloads similarly — the
      // memory verb's `rest[0]` is the sub-action word rather than the direction
      // id (a direction id in that slot means "read", never a sub-action word).
      // Every other verb uses only the first trailing positional as the id.
      const isBrief = verb === "brief";
      const isBriefMap = isBrief && rest[0] === "map";
      const isMemoryAction = verb === "memory" && isMemoryLifecycleAction(rest[0]);
      await runAction(() => {
        switch (verb) {
          case "new":
            return runDirectionNew({ cwd, name: rest[0], describe: cmdOpts.describe });
          case "list":
            return runDirection({
              cwd,
              verb,
              includeArchived: cmdOpts.includeArchived === true,
            });
          case "show":
            return runDirectionShow({ cwd, directionId: rest[0] });
          case "fork":
            return runDirectionFork({
              cwd,
              sourceId: rest[0],
              name: cmdOpts.name,
              count: parseCount(cmdOpts.count, forkUsage),
              withMemory: cmdOpts.withMemory === true,
            });
          case "create": {
            // R-6: ONE declared syntax — `direction create '<json>' --from <id>`.
            if (rest[1] !== undefined) {
              throw new CommandError(
                "direction create takes one positional (the JSON) — the source direction is passed with --from, not as a positional.\nUsage: keyart direction create '<json>' --from <directionId>",
              );
            }
            if (cmdOpts.from === undefined) {
              throw new CommandError(
                "direction create requires --from <directionId> (the direction whose brief seeds the new one).\nUsage: keyart direction create '<json>' --from <directionId>\nTo start from scratch, use `keyart direction new <name>` instead.",
              );
            }
            return runCreateDirection({
              cwd,
              verb,
              seedDirectionId: cmdOpts.from,
              json: rest[0],
            });
          }
          default:
            // status | archive | reject | park | revive | feedback | memory |
            // brief | reconcile — plus runDirection's teaching unknown-verb error.
            return runDirection({
              cwd,
              verb,
              id: isBrief ? rest[1] : isMemoryAction ? rest[1] : rest[0],
              subverb: isBrief ? rest[0] : undefined,
              field: isBrief && !isBriefMap ? rest[2] : undefined,
              value:
                isBrief && !isBriefMap && rest.length > 3
                  ? rest.slice(3).join(" ")
                  : undefined,
              json: isBrief && !isBriefMap ? rest[2] : undefined,
              // `map` joins everything after the id into the freeform ramble.
              freeform: isBriefMap ? rest.slice(2).join(" ") : undefined,
              apply: isBriefMap ? cmdOpts.apply === true : undefined,
              memoryAction: isMemoryAction ? rest[0] : undefined,
              entryId: isMemoryAction ? rest[2] : undefined,
              to: cmdOpts.to,
              reason: cmdOpts.reason,
              name: cmdOpts.name,
              from: cmdOpts.from,
              note: cmdOpts.note,
              body: cmdOpts.body,
              kind: cmdOpts.kind,
              author: cmdOpts.author,
              channel: cmdOpts.channel,
              polarity: cmdOpts.polarity,
              contradictionId: cmdOpts.contradiction,
              action: cmdOpts.action,
              winner: cmdOpts.winner,
              severity: cmdOpts.severity,
              expectedMemoryVersion: cmdOpts.expectedMemoryVersion,
              expectedGlobalVersion: cmdOpts.expectedGlobalVersion,
              force: cmdOpts.force,
            });
        }
      });
    },
  );

program
  .command("asset <verb> [assetId]")
  .description("Direction-scoped extracted assets: extract | regenerate | list | remove | pack")
  .option("--direction <dirId>", "Extraction source (extract, required), or target direction (regenerate | list | remove | pack; defaults to the approved direction)")
  .option("--describe <text>", "What to isolate, e.g. \"the yak mascot\" (extract, required)")
  .option("--image <name>", "Source image: styleTile (default) | homepageMockup | moodboard (extract only)")
  .option("--version <versionId>", "Source direction version (extract only; default: head)")
  .option("--crop <path>", "Crop reference image narrowing the subject (extract only)")
  .option("--name <name>", "Display name for the new asset (extract only)")
  .option("--tweak <text>", "The change to apply, e.g. \"make it face left\" (regenerate, required)")
  .option("--remember", "Also log the tweak as direction-scoped memory (regenerate only)")
  .option("--author <author>", "Attribution for the --remember entry (default: cli)")
  .action(async (verb: string, assetId: string | undefined, cmdOpts: AssetFlags) => {
    const cwd = program.opts().cwd as string;
    await runAction(() =>
      runAsset(cwd, assetId !== undefined ? [verb, assetId] : [verb], cmdOpts),
    );
  });

program
  .command("surface <verb> [args...]")
  .description("The demand-side surface manifest: schema | show | set | patch | request | retire | bind | fill | scan")
  .option("--include-retired", "Include retired slots (show only)")
  .option("--author <author>", "Attribution author for a requested slot (request only; default: agent)")
  .option("--source <source>", "Attribution source for a requested slot (request only; default: cli)")
  .option("--expected-version <n>", "Expected manifest version for optimistic write (set | patch | request | retire)", parseInt)
  .option("--force", "Bypass optimistic version checks")
  .option("--slot <id>", "Fill exactly this slot id (fill only; default: every asset-slot gap)")
  .option("--apply", "Merge every scanned candidate into brand/surface.yaml with origin:scan (scan only; default: propose-only)")
  .option("--no-refine", "Skip the key-gated vision refinement tier (floor proposal only; scan only)")
  .option("--refine-only", "Re-run refinement on the existing scan proposal (no URLs; requires a prior scan)")
  .option(
    "--dismiss <selector>",
    "Selector clicked after load to dismiss a gate/banner (scan only; repeatable, applied in order, absence-tolerant)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    "--wait-for <selector>",
    "Selector to await after load before observing (scan only; bounded timeout, absence-tolerant)",
  )
  .option(
    "--origin <origin>",
    "Bulk-retire every ACTIVE slot of this origin: authored | scan | request (retire only; mutually exclusive with <slotId>)",
  )
  .action(
    async (
      verb: string,
      args: string[],
      cmdOpts: SurfaceFlags & { refine?: boolean }, // commander maps --no-refine to { refine: false }
    ) => {
      const cwd = program.opts().cwd as string;
      const { refine, dismiss, ...flags } = cmdOpts;
      await runAction(() =>
        runSurface(cwd, [verb, ...args], {
          ...flags,
          ...(dismiss?.length ? { dismiss } : {}),
          ...(refine === false ? { noRefine: true } : {}),
        }),
      );
    },
  );

program
  .command("rule <verb> [text]")
  .description("Write or amend a deliberate GLOBAL brand rule: add | remove | edit")
  .option("--severity <severity>", "Rule severity: hard | guideline (default: guideline)")
  .option("--author <author>", "Attribution for the rule (default: cli)")
  .option("--channel <channel>", "Directive channel: visual | copy | both (default: classifier heuristic)")
  .option("--polarity <polarity>", "Directive polarity: prefer | avoid (default: classifier heuristic)")
  .option("--body <text>", "Replacement rule text (rule edit only)")
  .option("--expected-version <n>", "Expected global brand version for optimistic write (rule remove | edit)", parseInt)
  .option("--force", "Bypass optimistic version checks (also required to remove/edit a HARD rule)")
  .action(
    async (
      verb: string,
      text: string | undefined,
      cmdOpts: {
        severity?: string;
        author?: string;
        channel?: string;
        polarity?: string;
        body?: string;
        expectedVersion?: number;
        force?: boolean;
      },
    ) => {
      const cwd = program.opts().cwd as string;
      // `add` carries its text as the trailing positional; `remove`/`edit`
      // instead carry the target `<ruleId>` there (the replacement body, if
      // any, comes from `--body`).
      await runAction(() =>
        runRule({
          cwd,
          verb,
          text: verb === "add" ? text : undefined,
          ruleId: verb !== "add" ? text : undefined,
          body: cmdOpts.body,
          severity: cmdOpts.severity,
          author: cmdOpts.author,
          channel: cmdOpts.channel,
          polarity: cmdOpts.polarity,
          expectedVersion: cmdOpts.expectedVersion,
          force: cmdOpts.force,
        }),
      );
    },
  );

program
  .command("promote <directionId> [text]")
  .description("Lift one direction's learning into a global rule")
  .option("--entry <id>", "Pull the learning body from this memory entry id (retires the source entry)")
  .option("--severity <severity>", "Rule severity: hard | guideline (default: guideline)")
  .option("--author <author>", "Attribution for the rule (default: cli)")
  .option("--force", "Bypass optimistic version checks")
  .action(
    async (
      directionId: string,
      text: string | undefined,
      cmdOpts: {
        entry?: string;
        severity?: string;
        author?: string;
        force?: boolean;
      },
    ) => {
      const cwd = program.opts().cwd as string;
      await runAction(() =>
        runPromote({
          cwd,
          directionId,
          text,
          entryId: cmdOpts.entry,
          severity: cmdOpts.severity,
          author: cmdOpts.author,
          force: cmdOpts.force,
        }),
      );
    },
  );

// The configured program is exported (not parsed here) so it can be imported and
// its command wiring unit-tested with custom argv. The `keyart` bin
// (bin/keyart.js) calls `program.parse()` to run it as the CLI.
export { program };
