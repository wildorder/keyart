import path from "node:path";
import { CommandError } from "../errors.js";
import { loadConfig, surfaceManifestPath } from "../config.js";
import {
  createSurfaceCore,
  SLOT_ORIGINS,
  type RequestedSlot,
  type SlotOrigin,
} from "../surface/store.js";
import { renderScanBrief } from "../surface/render-scan-brief.js";
import { isSlotRetired } from "../surface/schema.js";
import type { SurfaceManifest, SurfaceSlot, SlotKind } from "../surface/schema.js";
import { runSurfaceBind, type SurfaceBindResult } from "../surface/bind.js";
import { runSurfaceFill, type SurfaceFillResult } from "../surface/fill.js";
import { runSurfaceScan, type SurfaceScanResult, type ScanSetup } from "../surface/scan.js";
import { runSurfaceRefine, type SurfaceRefineResult } from "../surface/refine.js";

export const SURFACE_VERBS = [
  "schema",
  "show",
  "set",
  "patch",
  "request",
  "retire",
  "bind",
  "fill",
  "scan",
] as const;
export type SurfaceVerb = (typeof SURFACE_VERBS)[number];

/** Typed flag bag — the CLI passes commander's cmdOpts directly; the MCP adapter
 *  maps ParsedArgs.flags (the AssetFlags convention). */
export interface SurfaceFlags {
  includeRetired?: boolean; // show only
  author?: string; // request only (default "agent")
  source?: string; // request only (default "cli"; the MCP helpDoc recommends "mcp")
  expectedVersion?: number; // set | patch | request | retire
  force?: boolean; // set | patch | request | retire
  slot?: string; // fill only — target exactly this slot id
  apply?: boolean; // scan only — merge candidates into brand/surface.yaml (default: propose-only)
  noRefine?: boolean; // scan only — skip the key-gated vision refinement tier
  refineOnly?: boolean; // scan only — re-run refinement on the existing proposal (no URLs)
  dismiss?: string[]; // scan only — selectors clicked in order after load (repeatable)
  waitFor?: string; // scan only — selector awaited (bounded) after load
  origin?: string; // retire only — bulk-retire every ACTIVE slot of this origin
}

/** One row of `surface show` output (also the summary substrate). */
export interface SurfaceShowRow {
  id: string;
  kind: SlotKind;
  criticality: "required" | "preferred";
  origin: "authored" | "scan" | "request";
  attributionCount: number;
  retired: boolean;
  description: string;
}

export type SurfaceCommandResult =
  | { verb: "schema"; brief: string; filesWritten: string[] } // filesWritten: []
  | {
      verb: "show";
      manifest: SurfaceManifest | null;
      rows: SurfaceShowRow[];
      filesWritten: string[]; // []
    }
  | { verb: "set" | "patch"; manifest: SurfaceManifest; filesWritten: string[] }
  | {
      verb: "request";
      manifest: SurfaceManifest;
      slotId: string;
      deduped: boolean;
      filesWritten: string[];
    }
  | {
      verb: "retire";
      slotId: string;
      retiredAt: string;
      alreadyRetired: boolean;
      filesWritten: string[];
    }
  | {
      verb: "retire";
      mode: "origin";
      origin: SlotOrigin;
      retiredIds: string[];
      alreadyRetiredCount: number;
      filesWritten: string[];
    }
  | ({ verb: "bind" } & SurfaceBindResult)
  | ({ verb: "fill" } & SurfaceFillResult)
  | ({ verb: "scan" } & SurfaceScanResult)
  | ({ verb: "scan"; mode: "refine-only" } & SurfaceRefineResult);

const USAGE: Record<SurfaceVerb, string> = {
  schema: "Usage: keyart surface schema",
  show: "Usage: keyart surface show [--include-retired]",
  set: 'Usage: keyart surface set \'<json array of slots>\' [--expected-version <n>] [--force]',
  patch: 'Usage: keyart surface patch \'<json array of slots>\' [--expected-version <n>] [--force]',
  request:
    'Usage: keyart surface request \'<json slot>\' [--author <author>] [--source <source>] [--expected-version <n>] [--force]',
  retire:
    "Usage: keyart surface retire <slotId> [--expected-version <n>] [--force]\n" +
    "       keyart surface retire --origin <authored|scan|request> [--expected-version <n>] [--force]",
  bind: "Usage: keyart surface bind",
  fill: "Usage: keyart surface fill [--slot <id>]",
  scan:
    "Usage: keyart surface scan <url...> [--apply] [--no-refine] [--dismiss <selector>]... [--wait-for <selector>]\n" +
    "       keyart surface scan --refine-only",
};

/** Display form of each `SurfaceFlags` key — the CLI flag name it maps to. */
const FLAG_DISPLAY: Record<keyof SurfaceFlags, string> = {
  includeRetired: "--include-retired",
  author: "--author",
  source: "--source",
  expectedVersion: "--expected-version",
  force: "--force",
  slot: "--slot",
  apply: "--apply",
  noRefine: "--no-refine",
  refineOnly: "--refine-only",
  dismiss: "--dismiss",
  waitFor: "--wait-for",
  origin: "--origin",
};

function relTo(cwd: string): (abs: string) => string {
  const resolved = path.resolve(cwd);
  return (abs: string): string =>
    path.relative(resolved, abs).split(path.sep).join("/");
}

/** Rejects any flag not in `allowed` for `verb` — the runConcept wrong-verb-coupling idiom. */
function assertOnlyFlags(
  verb: SurfaceVerb,
  flags: SurfaceFlags,
  allowed: (keyof SurfaceFlags)[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(flags) as (keyof SurfaceFlags)[]) {
    const value = flags[key];
    // `force: false` (the CLI/MCP unset-boolean default) and an empty repeatable
    // array (commander's default for --dismiss) are not "given".
    if (value === undefined || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (!allowedSet.has(key)) {
      throw new CommandError(
        `${FLAG_DISPLAY[key]} is not valid with surface ${verb}.\n${USAGE[verb]}`,
      );
    }
  }
}

function parseJsonPayload(payload: string, verb: SurfaceVerb): unknown {
  try {
    return JSON.parse(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Invalid JSON payload for surface ${verb}: ${message}\n${USAGE[verb]}`,
    );
  }
}

function toRow(slot: SurfaceSlot): SurfaceShowRow {
  return {
    id: slot.id,
    kind: slot.kind,
    criticality: slot.criticality,
    origin: slot.origin,
    attributionCount: slot.attributions.length,
    retired: isSlotRetired(slot),
    description: slot.description,
  };
}

export async function runSurface(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  const verb = rest[0];
  if (!(SURFACE_VERBS as readonly string[]).includes(verb)) {
    throw new CommandError(
      `Unknown surface verb "${verb}". Supported: schema, show, set, patch, request, retire, bind, fill, scan.`,
    );
  }

  switch (verb as SurfaceVerb) {
    case "schema":
      return surfaceSchema(cwd, rest, flags);
    case "show":
      return surfaceShow(cwd, rest, flags);
    case "set":
      return surfaceSet(cwd, rest, flags);
    case "patch":
      return surfacePatch(cwd, rest, flags);
    case "request":
      return surfaceRequest(cwd, rest, flags);
    case "retire":
      return surfaceRetire(cwd, rest, flags);
    case "bind":
      return surfaceBind(cwd, rest, flags);
    case "fill":
      return surfaceFill(cwd, rest, flags);
    case "scan":
      return surfaceScan(cwd, rest, flags);
  }
}

async function surfaceSchema(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`Too many arguments for surface schema.\n${USAGE.schema}`);
  }
  assertOnlyFlags("schema", flags, []);

  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);
  const brief = renderScanBrief(await core.read());
  console.log(brief);

  return { verb: "schema", brief, filesWritten: [] };
}

async function surfaceShow(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`surface show takes no positional argument.\n${USAGE.show}`);
  }
  assertOnlyFlags("show", flags, ["includeRetired"]);

  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);
  const manifest = await core.read();

  if (manifest === null) {
    console.log(
      "No surface manifest yet. A host agent can author one against `surface schema` and write it with `surface set`.",
    );
    return { verb: "show", manifest: null, rows: [], filesWritten: [] };
  }

  const includeRetired = flags.includeRetired === true;
  const visibleSlots = manifest.slots.filter(
    (s) => includeRetired || !isSlotRetired(s),
  );
  const hiddenCount = manifest.slots.length - visibleSlots.length;
  const header = `${manifest.slots.length} slot(s) (version ${manifest.version})${
    hiddenCount > 0 ? `, ${hiddenCount} retired hidden` : ""
  }.`;
  const lines = visibleSlots.map((s) => {
    const row = toRow(s);
    const retiredSuffix = row.retired ? ` (retired ${s.retiredAt})` : "";
    return `${row.id}  [${row.kind}]  ${row.criticality}  origin=${row.origin}  attributions=${row.attributionCount}${retiredSuffix}`;
  });
  console.log([header, ...lines].join("\n"));

  return { verb: "show", manifest, rows: visibleSlots.map(toRow), filesWritten: [] };
}

async function surfaceSet(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 2) {
    throw new CommandError(`Too many arguments for surface set.\n${USAGE.set}`);
  }
  assertOnlyFlags("set", flags, ["expectedVersion", "force"]);
  const payload = rest[1];
  if (payload === undefined) {
    throw new CommandError(`surface set requires a JSON payload.\n${USAGE.set}`);
  }
  const parsed = parseJsonPayload(payload, "set");
  if (!Array.isArray(parsed)) {
    throw new CommandError(
      `surface set expects a JSON array of slot objects, not a single object.\n${USAGE.set}`,
    );
  }

  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);
  const manifest = await core.setManifest(parsed as SurfaceSlot[], {
    expectedVersion: flags.expectedVersion,
    force: flags.force,
  });

  console.log(
    `Surface manifest set: ${manifest.slots.length} slot(s) (version ${manifest.version}).`,
  );

  return {
    verb: "set",
    manifest,
    filesWritten: [relTo(cwd)(surfaceManifestPath(cwd, config))],
  };
}

async function surfacePatch(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 2) {
    throw new CommandError(`Too many arguments for surface patch.\n${USAGE.patch}`);
  }
  assertOnlyFlags("patch", flags, ["expectedVersion", "force"]);
  const payload = rest[1];
  if (payload === undefined) {
    throw new CommandError(`surface patch requires a JSON payload.\n${USAGE.patch}`);
  }
  const parsed = parseJsonPayload(payload, "patch");
  if (!Array.isArray(parsed)) {
    throw new CommandError(
      `surface patch expects a JSON array of slot objects, not a single object.\n${USAGE.patch}`,
    );
  }

  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);
  const manifest = await core.patchSlots(parsed as SurfaceSlot[], {
    expectedVersion: flags.expectedVersion,
    force: flags.force,
  });

  console.log(
    `Surface manifest patched: ${parsed.length} slot(s) upserted (version ${manifest.version}).`,
  );

  return {
    verb: "patch",
    manifest,
    filesWritten: [relTo(cwd)(surfaceManifestPath(cwd, config))],
  };
}

async function surfaceRequest(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 2) {
    throw new CommandError(`Too many arguments for surface request.\n${USAGE.request}`);
  }
  assertOnlyFlags("request", flags, ["author", "source", "expectedVersion", "force"]);
  const payload = rest[1];
  if (payload === undefined) {
    throw new CommandError(`surface request requires a JSON payload.\n${USAGE.request}`);
  }
  const parsed = parseJsonPayload(payload, "request");
  if (Array.isArray(parsed)) {
    throw new CommandError(
      `surface request takes one slot, not a JSON array — batch authorship is surface set/patch.\n${USAGE.request}`,
    );
  }

  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);
  const attribution = {
    author: flags.author ?? "agent",
    source: flags.source ?? "cli",
    date: new Date().toISOString(),
  };
  const { manifest, slotId, deduped } = await core.requestSlot(
    parsed as RequestedSlot,
    attribution,
    { expectedVersion: flags.expectedVersion, force: flags.force },
  );

  const slot = manifest.slots.find((s) => s.id === slotId);
  const attributionCount = slot?.attributions.length ?? 1;
  console.log(
    deduped
      ? `Slot "${slotId}" already exists — appended an attribution (now ${attributionCount}).`
      : `Recorded requested slot "${slotId}" (origin: request).`,
  );

  return {
    verb: "request",
    manifest,
    slotId,
    deduped,
    filesWritten: [relTo(cwd)(surfaceManifestPath(cwd, config))],
  };
}

async function surfaceRetire(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 2) {
    throw new CommandError(`Too many arguments for surface retire.\n${USAGE.retire}`);
  }
  assertOnlyFlags("retire", flags, ["expectedVersion", "force", "origin"]);
  const slotId = rest[1];
  const originRaw = flags.origin;

  // Mutually exclusive: exactly one target selector, always.
  if (slotId !== undefined && originRaw !== undefined) {
    throw new CommandError(
      `surface retire takes EITHER a slotId OR --origin <origin>, not both.\n${USAGE.retire}`,
    );
  }
  if (slotId === undefined && originRaw === undefined) {
    throw new CommandError(
      `surface retire requires a slotId or --origin <origin>.\n${USAGE.retire}`,
    );
  }

  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);
  const writeOpts = { expectedVersion: flags.expectedVersion, force: flags.force };

  if (originRaw !== undefined) {
    if (!(SLOT_ORIGINS as readonly string[]).includes(originRaw)) {
      throw new CommandError(
        `Unknown origin ${JSON.stringify(originRaw)} — valid origins: ${SLOT_ORIGINS.join(", ")}.\n${USAGE.retire}`,
      );
    }
    const origin = originRaw as SlotOrigin;
    const { retiredIds, alreadyRetiredCount } = await core.retireSlotsByOrigin(
      origin,
      writeOpts,
    );

    console.log(
      retiredIds.length === 0
        ? `No active "${origin}" slots to retire` +
            (alreadyRetiredCount > 0 ? ` (${alreadyRetiredCount} already retired).` : ".")
        : `Retired ${retiredIds.length} slot(s) with origin "${origin}" (non-destructive retire):\n` +
            retiredIds.map((id) => `  - ${id}`).join("\n"),
    );

    return {
      verb: "retire",
      mode: "origin",
      origin,
      retiredIds,
      alreadyRetiredCount,
      filesWritten:
        retiredIds.length === 0 ? [] : [relTo(cwd)(surfaceManifestPath(cwd, config))],
    };
  }

  const { retiredAt, alreadyRetired } = await core.retireSlot(slotId!, writeOpts);

  console.log(
    alreadyRetired
      ? `Slot "${slotId}" was already retired.`
      : `Retired slot "${slotId}" (non-destructive retire).`,
  );

  return {
    verb: "retire",
    slotId: slotId!,
    retiredAt,
    alreadyRetired,
    filesWritten: alreadyRetired ? [] : [relTo(cwd)(surfaceManifestPath(cwd, config))],
  };
}

async function surfaceBind(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`Too many arguments for surface bind.\n${USAGE.bind}`);
  }
  assertOnlyFlags("bind", flags, []);

  const result = await runSurfaceBind({ cwd });

  const counts = { bound: 0, derived: 0, pending: 0, gap: 0 };
  for (const slot of result.binding.slots) {
    counts[slot.status] += 1;
  }

  const lines = [
    `Surface bound for ${result.directionId}@${result.versionId}: ` +
      `${counts.bound} bound, ${counts.derived} derived, ${counts.pending} pending, ` +
      `${counts.gap} gaps → ${result.bindingPath}`,
  ];

  for (const slot of result.binding.slots) {
    if (slot.status !== "pending") continue;
    lines.push(
      `  ~ ${slot.slotId} — pending: asset "${slot.assetId}" has no image yet ` +
        "(add a key and regenerate, or run surface fill)",
    );
  }

  for (const gap of result.gaps) {
    let line = `  ✗ ${gap.slotId} (${gap.kind}, ${gap.criticality}, origin: ${gap.origin})`;
    if (gap.origin === "request") {
      line += ` — requested ${gap.attributionCount}x`;
    }
    if (gap.taxonomyDemand) {
      line += ' — taxonomy demand (kind "other")';
    }
    lines.push(line);
  }

  console.log(lines.join("\n"));

  return { verb: "bind", ...result };
}

async function surfaceFill(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`Too many arguments for surface fill.\n${USAGE.fill}`);
  }
  assertOnlyFlags("fill", flags, ["slot"]);

  const result = await runSurfaceFill({ cwd, slot: flags.slot });

  if (result.filled.length === 0) {
    console.log("No asset-slot gaps to fill.");
    return { verb: "fill", ...result };
  }

  const lines: string[] = [];
  if (result.dryRun) {
    lines.push(
      `Recorded ${result.filled.length} pending fill(s) for ${result.directionId}@${result.versionId} — dry-run, no images. Add OPENAI_API_KEY and re-run \`asset regenerate\` per asset (or retire + refill).`,
    );
    for (const f of result.filled) {
      lines.push(`  ~ ${f.slotId} → ${f.assetId} (pending)`);
    }
  } else {
    lines.push(
      `Filled ${result.filled.length} slot(s) for ${result.directionId}@${result.versionId}.`,
    );
    for (const f of result.filled) {
      lines.push(`  ✓ ${f.slotId} → ${f.assetId} (${f.versionId})`);
    }
    const imageSkips = result.filled.flatMap((f) => f.imageSkips);
    if (imageSkips.length > 0) {
      lines.push(`Warnings:\n${imageSkips.map((s) => `- ${s}`).join("\n")}`);
    }
  }
  lines.push("Run `keyart surface bind` to refresh binding.json.");

  console.log(lines.join("\n"));

  return { verb: "fill", ...result };
}

async function surfaceScan(
  cwd: string,
  rest: string[],
  flags: SurfaceFlags,
): Promise<SurfaceCommandResult> {
  assertOnlyFlags("scan", flags, ["apply", "noRefine", "refineOnly", "dismiss", "waitFor"]);
  const urls = rest.slice(1);

  if (flags.refineOnly === true) {
    if (
      urls.length > 0 ||
      flags.apply === true ||
      flags.noRefine === true ||
      (flags.dismiss?.length ?? 0) > 0 ||
      flags.waitFor !== undefined
    ) {
      throw new CommandError(
        `--refine-only takes no URLs and cannot combine with --apply, --no-refine, --dismiss, or --wait-for.\n${USAGE.scan}`,
      );
    }
    const result = await runSurfaceRefine({ cwd });
    return { verb: "scan", mode: "refine-only", ...result };
  }

  if (urls.length === 0) {
    throw new CommandError(`surface scan requires at least one URL.\n${USAGE.scan}`);
  }

  const setup: ScanSetup = {
    ...(flags.waitFor ? { waitFor: flags.waitFor } : {}),
    ...(flags.dismiss?.length ? { dismiss: flags.dismiss } : {}),
  };
  const result = await runSurfaceScan({
    cwd,
    urls,
    apply: flags.apply === true,
    noRefine: flags.noRefine === true,
    ...(Object.keys(setup).length ? { setup } : {}),
  });

  return { verb: "scan", ...result };
}
