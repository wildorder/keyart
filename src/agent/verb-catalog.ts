import type { ArgSpec, FlagSpec } from "../mcp/registry.js";
import { getCommand } from "../mcp/registry.js";

export type Mutates = "none" | "write" | "destructive";

/**
 * Where the studio's focused directionId is injected when the model omits it.
 * A leaf's focus slot is sometimes a flag (e.g. `--direction` on the asset
 * leaves, `--from` on `direction_create`) and sometimes a positional (`id` for
 * the `direction_*` leaves, `directionId` for regenerate/approve/promote).
 * This keeps the injection explicit and per-leaf rather than assuming a flag.
 */
export type ContextSlot =
  | { kind: "flag"; name: string } // e.g. { kind: "flag", name: "--direction" }
  | { kind: "positional"; name: string }; // e.g. { kind: "positional", name: "id" }

export interface ContextBinding {
  /** The slot that receives ctx.directionId when the model omits it. Absent ⇒ the
   *  leaf takes no focus target (e.g. `doctor`, `direction_list`) OR must NOT
   *  inherit it (e.g. `direction_new`, which CREATES a direction — inheriting the
   *  focused id would clobber). */
  directionSlot?: ContextSlot;
}

export interface VerbLeaf {
  toolName: string; // "direction_memory_edit" — OpenAI tool name (snake_case, unique)
  command: string; // "direction" — the registry command to dispatch
  verb?: string; // "memory" — leading positional token prepended before model args
  subAction?: string; // "edit" — second fixed positional for expanded memory/brief leaves
  description: string; // DERIVED from the command summary + the verb path (never hand-copied)
  positionals: ArgSpec[]; // ONLY this leaf's applicable, model-facing positionals (verb/subAction excluded)
  flags: FlagSpec[]; // ONLY this leaf's applicable flags (real FlagSpec objects from getCommand)
  mutates: Mutates;
  contextBinding: ContextBinding; // how the studio focus fills an omitted direction id
}

interface LeafSpec {
  toolName: string;
  command: string;
  verb?: string;
  subAction?: string;
  positionals: ArgSpec[];
  flagNames: string[];
  mutates: Mutates;
  contextBinding: ContextBinding;
}

/**
 * The read-from-registry constructor every leaf goes through, so no leaf can carry
 * a fabricated command or flag. Throws loudly (drift guard) if `spec.command` is
 * unknown, not dispatchable, or names a flag `getCommand(spec.command)` does not have.
 */
function deriveLeaf(spec: LeafSpec): VerbLeaf {
  const meta = getCommand(spec.command);
  if (!meta) {
    throw new Error(`verb-catalog: unknown command "${spec.command}"`);
  }
  if (!meta.dispatchable) {
    throw new Error(
      `verb-catalog: command "${spec.command}" is not dispatchable and cannot be a leaf`,
    );
  }
  const flags = spec.flagNames.map((name) => {
    const f = meta.flags.find((x) => x.name === name);
    if (!f) {
      throw new Error(`verb-catalog: ${spec.command} has no flag "${name}"`);
    }
    return f; // REAL FlagSpec object — single source of description/takesValue
  });
  const label = [meta.name, spec.verb, spec.subAction].filter(Boolean).join(" ");
  return {
    toolName: spec.toolName,
    command: spec.command,
    verb: spec.verb,
    subAction: spec.subAction,
    description: `${label} — ${meta.summary}`, // DERIVED from live meta.summary
    positionals: spec.positionals,
    flags,
    mutates: spec.mutates,
    contextBinding: spec.contextBinding,
  };
}

// ---------------------------------------------------------------------------
// The catalog. Simple commands (explore, regenerate, approve, audit, brief,
// doctor, promote) map 1:1 and reuse `meta.args` directly — the strongest
// derivation. `serve` is `dispatchable: false` and is never a leaf.
//
// `direction` and `rule` expand into per-verb leaves. The `direction` meta's
// positional slots (`id`/`target`/`detail`/`value`) are generic overloaded
// slots in the registry — there is no per-verb ArgSpec to derive from, so each
// leaf synthesizes its own meaningfully-named positional ArgSpec (leaf-local,
// disclosed here, not hidden). Flag wording remains 100% derived via
// `deriveLeaf`.
//
// NOTE (verified against the merged `src/mcp/registry.ts` +
// `src/commands/direction.ts`, which take precedence over any illustrative
// snippet): `direction feedback`'s MCP dispatch (`directionMeta.run`) reads the
// entry body ONLY from the `--body` flag — a positional after `id` is never
// consumed. So `direction_feedback` carries `id` as its only model-facing
// positional and `--body` among its flags.
//
// The `show`/`status`/`fork`/`archive`/`reject`/`park`/`revive` verbs
// deliberately get NO catalog leaves — they stay MCP-dispatchable through
// `keyart_brand` via the grown `direction` meta, and adding leaves would
// break the 27-leaf contract downstream consumers pin.
// ---------------------------------------------------------------------------

const LEAVES: VerbLeaf[] = [
  // --- Simple 1:1 commands ---------------------------------------------
  deriveLeaf({
    toolName: "explore",
    command: "explore",
    positionals: getCommand("explore")!.args,
    flagNames: ["--count", "--reference", "--intent", "--describe", "--from"],
    mutates: "write",
    contextBinding: {
      directionSlot: { kind: "positional", name: "directionId" },
    },
  }),
  deriveLeaf({
    toolName: "regenerate",
    command: "regenerate",
    positionals: getCommand("regenerate")!.args,
    flagNames: ["--tweak"],
    mutates: "write",
    contextBinding: {
      directionSlot: { kind: "positional", name: "directionId" },
    },
  }),
  deriveLeaf({
    toolName: "approve",
    command: "approve",
    positionals: getCommand("approve")!.args,
    flagNames: ["--force"],
    mutates: "destructive",
    contextBinding: {
      directionSlot: { kind: "positional", name: "directionId" },
    },
  }),
  deriveLeaf({
    toolName: "audit",
    command: "audit",
    positionals: getCommand("audit")!.args,
    flagNames: [],
    mutates: "write",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "brief",
    command: "brief",
    positionals: getCommand("brief")!.args,
    flagNames: ["--force"],
    mutates: "write",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "doctor",
    command: "doctor",
    positionals: getCommand("doctor")!.args,
    flagNames: [],
    mutates: "none",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "promote",
    command: "promote",
    positionals: getCommand("promote")!.args,
    flagNames: ["--entry", "--severity", "--author", "--force"],
    mutates: "write",
    contextBinding: { directionSlot: { kind: "positional", name: "directionId" } },
  }),

  // --- `direction` expansion (12 leaves) -----------------------------------
  deriveLeaf({
    toolName: "direction_new",
    command: "direction",
    verb: "new",
    positionals: [
      { name: "name", required: true, description: "Display name for the new draft direction." },
    ],
    flagNames: ["--describe"],
    mutates: "write",
    // CREATES a direction — must NOT inherit the studio's focused direction id.
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "direction_list",
    command: "direction",
    verb: "list",
    positionals: [],
    flagNames: ["--include-archived"],
    mutates: "none",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "direction_feedback",
    command: "direction",
    verb: "feedback",
    positionals: [
      { name: "id", required: true, description: "The direction to record feedback on." },
    ],
    flagNames: ["--body", "--kind", "--author", "--channel", "--polarity"],
    mutates: "write",
    contextBinding: {
      directionSlot: { kind: "positional", name: "id" },
    },
  }),
  deriveLeaf({
    toolName: "direction_memory_read",
    command: "direction",
    verb: "memory",
    positionals: [
      { name: "id", required: true, description: "The direction whose memory to read." },
    ],
    flagNames: [],
    mutates: "none",
    contextBinding: {
      directionSlot: { kind: "positional", name: "id" },
    },
  }),
  deriveLeaf({
    toolName: "direction_memory_edit",
    command: "direction",
    verb: "memory",
    subAction: "edit",
    positionals: [
      { name: "id", required: true, description: "The direction whose memory entry to edit." },
      { name: "entryId", required: true, description: "The memory entry id to edit." },
    ],
    flagNames: ["--body", "--channel", "--polarity", "--author", "--expected-memory-version", "--force"],
    mutates: "write",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_memory_promote",
    command: "direction",
    verb: "memory",
    subAction: "promote",
    positionals: [
      { name: "id", required: true, description: "The direction whose memory entry to promote." },
      { name: "entryId", required: true, description: "The memory entry id to promote." },
    ],
    flagNames: [
      "--to",
      "--severity",
      "--author",
      "--expected-memory-version",
      "--expected-global-version",
      "--force",
    ],
    mutates: "write",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_memory_delete",
    command: "direction",
    verb: "memory",
    subAction: "delete",
    positionals: [
      { name: "id", required: true, description: "The direction whose memory entry to delete." },
      { name: "entryId", required: true, description: "The memory entry id to delete (retire)." },
    ],
    flagNames: ["--reason", "--author", "--expected-memory-version", "--force"],
    mutates: "destructive",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_brief_show",
    command: "direction",
    verb: "brief",
    subAction: "show",
    positionals: [
      { name: "id", required: true, description: "The direction whose brief to show." },
    ],
    flagNames: [],
    mutates: "none",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_brief_set",
    command: "direction",
    verb: "brief",
    subAction: "set",
    positionals: [
      { name: "id", required: true, description: "The direction whose brief field to set." },
      { name: "field", required: true, description: "The brief field name to set." },
      {
        name: "value",
        required: true,
        description: "The value for the field (comma-separated for array fields).",
      },
    ],
    flagNames: [],
    mutates: "write",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_brief_patch",
    command: "direction",
    verb: "brief",
    subAction: "patch",
    positionals: [
      { name: "id", required: true, description: "The direction whose brief to patch." },
      { name: "json", required: true, description: "A JSON object patch of brief fields." },
    ],
    flagNames: [],
    mutates: "write",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_reconcile",
    command: "direction",
    verb: "reconcile",
    positionals: [
      {
        name: "id",
        required: true,
        description: "The direction to reconcile memory contradictions for.",
      },
    ],
    flagNames: [
      "--contradiction",
      "--action",
      "--winner",
      "--severity",
      "--expected-memory-version",
      "--expected-global-version",
      "--force",
    ],
    // A bare `direction reconcile <id>` (no --action) only lists contradictions,
    // but the --action keep|retire|supersede|promote path writes memory.yaml /
    // brand.yaml. Classified by the leaf's MAXIMAL effect so the downstream
    // confirm gate never lets a write-capable reconcile through un-gated.
    mutates: "write",
    contextBinding: { directionSlot: { kind: "positional", name: "id" } },
  }),
  deriveLeaf({
    toolName: "direction_create",
    command: "direction",
    verb: "create",
    // The registry's `id` slot is a generic overloaded slot, so the leaf
    // synthesizes the one model-facing positional (the JSON payload); the
    // REQUIRED seed travels as the `--from` flag (derived via deriveLeaf).
    positionals: [
      {
        name: "json",
        required: true,
        description:
          "The authored-content JSON object (name/summary/character/usage/copyExamples).",
      },
    ],
    flagNames: ["--from"],
    mutates: "write",
    // The focused direction is the natural seed; a model-supplied --from is
    // never overridden.
    contextBinding: { directionSlot: { kind: "flag", name: "--from" } },
  }),

  // --- `rule` expansion (3 leaves) ----------------------------------------
  deriveLeaf({
    toolName: "rule_add",
    command: "rule",
    verb: "add",
    positionals: [{ name: "text", required: true, description: "The rule text to add." }],
    flagNames: ["--severity", "--author", "--channel", "--polarity"],
    mutates: "write",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "rule_remove",
    command: "rule",
    verb: "remove",
    positionals: [
      { name: "ruleId", required: true, description: "The rule id to remove (retire)." },
    ],
    flagNames: ["--expected-version", "--force"],
    mutates: "destructive",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "rule_edit",
    command: "rule",
    verb: "edit",
    positionals: [{ name: "ruleId", required: true, description: "The rule id to edit." }],
    flagNames: ["--body", "--severity", "--expected-version", "--force"],
    mutates: "destructive",
    contextBinding: {},
  }),

  // --- `asset` expansion (5 leaves, asset-extraction WS-04) ----------------
  // The registry exposes `assetId` only as a generic optional trailing slot
  // shared by regenerate/remove, so each leaf below declares its own required,
  // meaningfully-described ArgSpec (LEAF-SYNTHESIZED — disclosed, not hidden;
  // the `entryId`/`ruleId` precedent). Flag wording remains 100% derived via
  // `deriveLeaf`. `asset_remove` is classified `destructive` — it retires
  // user-visible work (the `rule_remove`/`direction_memory_delete` weight)
  // even though the underlying write is a non-destructive retire marker.
  // `asset_pack` is `write` (writes a folder, deliberate but non-destructive).
  // `asset_list` is `none` (pure read — dispatches without the gate).
  // `asset_extract`'s direction inheritance means an id-free chat "extract the
  // yak" resolves to the focused direction via applyContext. `asset_regenerate`
  // deliberately has NO directionSlot: the asset is addressed by id and its
  // direction lives on the record (injecting the focused direction could
  // contradict it).
  deriveLeaf({
    toolName: "asset_extract",
    command: "asset",
    verb: "extract",
    positionals: [],
    flagNames: ["--direction", "--describe", "--image", "--version", "--crop", "--name"],
    mutates: "write",
    contextBinding: {
      directionSlot: { kind: "flag", name: "--direction" },
    },
  }),
  deriveLeaf({
    toolName: "asset_regenerate",
    command: "asset",
    verb: "regenerate",
    positionals: [
      { name: "assetId", required: true, description: "The extracted-asset id to regenerate (e.g. yak-mascot)." },
    ],
    flagNames: ["--tweak", "--remember", "--author"],
    mutates: "write",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "asset_list",
    command: "asset",
    verb: "list",
    positionals: [],
    flagNames: ["--direction"],
    mutates: "none",
    contextBinding: {
      directionSlot: { kind: "flag", name: "--direction" },
    },
  }),
  deriveLeaf({
    toolName: "asset_remove",
    command: "asset",
    verb: "remove",
    positionals: [
      { name: "assetId", required: true, description: "The extracted-asset id to remove (non-destructive retire)." },
    ],
    flagNames: [],
    mutates: "destructive",
    contextBinding: {},
  }),
  deriveLeaf({
    toolName: "asset_pack",
    command: "asset",
    verb: "pack",
    positionals: [],
    flagNames: ["--direction"],
    mutates: "write",
    contextBinding: {
      directionSlot: { kind: "flag", name: "--direction" },
    },
  }),
];

Object.freeze(LEAVES);

export function listLeaves(): VerbLeaf[] {
  return LEAVES;
}

export function getLeaf(toolName: string): VerbLeaf | undefined {
  return LEAVES.find((l) => l.toolName === toolName);
}

/**
 * Fill the leaf's focused-direction slot from the studio focus ONLY when the model
 * omitted it. Pure: returns a NEW args object; never mutates `args`; never fills a
 * slot the leaf does not declare; never overrides a value the model supplied; no
 * filesystem access.
 */
export function applyContext(
  leaf: VerbLeaf,
  args: Record<string, unknown>,
  ctx: { directionId?: string },
): Record<string, unknown> {
  const out = { ...args };
  const slot = leaf.contextBinding.directionSlot;
  if (slot && ctx.directionId !== undefined) {
    const key = slot.kind === "flag" ? slot.name.replace(/^--+/, "") : slot.name;
    if (out[key] === undefined || out[key] === "") out[key] = ctx.directionId;
  }
  return out;
}

/**
 * Produce exactly the token array `parseArgs(getCommand(leaf.command)!, tokens)`
 * accepts: fixed verb/subAction tokens first, then model-facing positionals in
 * order, then flags (value-flags as `--name value`, boolean flags as bare
 * `--name` only when `true`). Pure — never validates, never throws; absent args
 * are simply omitted.
 */
export function toolCallToTokens(leaf: VerbLeaf, args: Record<string, unknown>): string[] {
  const tokens: string[] = [];
  if (leaf.verb) tokens.push(leaf.verb);
  if (leaf.subAction) tokens.push(leaf.subAction);
  for (const p of leaf.positionals) {
    const v = args[p.name];
    if (v === undefined || v === null) continue;
    tokens.push(String(v));
  }
  for (const f of leaf.flags) {
    const key = f.name.replace(/^--+/, "");
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (f.takesValue) {
      tokens.push(f.name, String(v));
    } else if (v === true) {
      tokens.push(f.name);
    }
  }
  return tokens;
}
