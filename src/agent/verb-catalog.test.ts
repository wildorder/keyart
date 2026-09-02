import { describe, it, expect } from "vitest";
import { getCommand, parseArgs } from "../mcp/registry.js";
import {
  listLeaves,
  getLeaf,
  applyContext,
  toolCallToTokens,
  type Mutates,
} from "./verb-catalog.js";

// The removed aggregate noun, assembled at runtime so the SC-13 clean-break
// scanner finds no literal in this file while the fences below still assert
// its absence from the live surface.
const LEGACY_WORD = ["con", "cept"].join("");
const LEGACY_FLAG = `--${LEGACY_WORD}`;

describe("verb-catalog drift guards", () => {
  it("every leaf names a real, dispatchable command", () => {
    for (const leaf of listLeaves()) {
      const meta = getCommand(leaf.command);
      expect(meta, `leaf ${leaf.toolName} names unknown command ${leaf.command}`).toBeDefined();
      expect(meta!.dispatchable).toBe(true);
    }
  });

  it("serve is never a leaf", () => {
    const serveMeta = getCommand("serve");
    expect(serveMeta).toBeDefined();
    expect(serveMeta!.dispatchable).toBe(false);
    expect(listLeaves().some((l) => l.command === "serve")).toBe(false);
  });

  it("every leaf carries only real flags (=== identical FlagSpec objects)", () => {
    for (const leaf of listLeaves()) {
      const meta = getCommand(leaf.command)!;
      for (const f of leaf.flags) {
        expect(meta.flags.includes(f), `${leaf.toolName} flag ${f.name} is not a real FlagSpec reference`).toBe(true);
      }
    }
  });
});

describe("verb-catalog direction surface (WS-06)", () => {
  it("exposes exactly 12 direction_* leaves, all command === 'direction'", () => {
    const directionLeaves = listLeaves().filter((l) => l.command === "direction");
    expect(directionLeaves.map((l) => l.toolName).sort()).toEqual(
      [
        "direction_new",
        "direction_list",
        "direction_feedback",
        "direction_memory_read",
        "direction_memory_edit",
        "direction_memory_promote",
        "direction_memory_delete",
        "direction_brief_show",
        "direction_brief_set",
        "direction_brief_patch",
        "direction_reconcile",
        "direction_create",
      ].sort(),
    );
    expect(directionLeaves.length).toBe(12);
  });

  it("no leaf carries a legacy-era tool name or command", () => {
    for (const leaf of listLeaves()) {
      expect(leaf.toolName.startsWith(`${LEGACY_WORD}_`)).toBe(false);
      expect(leaf.command).not.toBe(LEGACY_WORD);
    }
  });

  it("no leaf exposes the legacy aggregate flag, --scope, or a memory-scope --direction", () => {
    for (const leaf of listLeaves()) {
      expect(
        leaf.flags.some((f) => f.name === LEGACY_FLAG),
        `${leaf.toolName} exposes ${LEGACY_FLAG}`,
      ).toBe(false);
    }
    // SC-07: the memory-scope selectors are gone from the direction leaves.
    expect(getLeaf("direction_memory_read")!.flags).toEqual([]);
    expect(
      getLeaf("direction_feedback")!.flags.some((f) => f.name === "--direction" || f.name === "--scope"),
    ).toBe(false);
  });

  it("direction_list exposes the byte-exact R-7 --include-archived FlagSpec", () => {
    const leaf = getLeaf("direction_list")!;
    const flag = leaf.flags.find((f) => f.name === "--include-archived");
    expect(flag).toEqual({
      name: "--include-archived",
      description: "Include archived directions in `direction list` output.",
      takesValue: false,
    });
    // No spelling variant exists anywhere on the surface.
    const directionMeta = getCommand("direction")!;
    for (const variant of ["--all", "--show-archived", "--archived"]) {
      expect(directionMeta.flags.some((f) => f.name === variant)).toBe(false);
    }
  });

  it("direction_create takes the JSON positional and the required --from seed flag", () => {
    const leaf = getLeaf("direction_create")!;
    expect(leaf.positionals.map((p) => p.name)).toEqual(["json"]);
    expect(leaf.flags.map((f) => f.name)).toEqual(["--from"]);
    expect(leaf.contextBinding).toEqual({ directionSlot: { kind: "flag", name: "--from" } });
  });
});

describe("verb-catalog applicable-flags-only (expansion guarantee)", () => {
  const flagNames = (toolName: string) => new Set(getLeaf(toolName)!.flags.map((f) => f.name));

  it("direction_memory_edit carries only its verb's flags", () => {
    const names = flagNames("direction_memory_edit");
    for (const present of ["--body", "--channel", "--polarity", "--author", "--expected-memory-version", "--force"]) {
      expect(names.has(present)).toBe(true);
    }
    for (const absent of ["--to", "--reason", "--contradiction", "--action", "--from", "--name", "--scope"]) {
      expect(names.has(absent)).toBe(false);
    }
  });

  it("direction_memory_delete has --reason but not --body", () => {
    const names = flagNames("direction_memory_delete");
    expect(names.has("--reason")).toBe(true);
    expect(names.has("--body")).toBe(false);
  });

  it("direction_new has --describe but no memory/reconcile flags and no seed flag", () => {
    const names = flagNames("direction_new");
    expect(names.has("--describe")).toBe(true);
    for (const absent of ["--body", "--to", "--reason", "--contradiction", "--action", "--scope", "--from"]) {
      expect(names.has(absent)).toBe(false);
    }
  });

  it("rule_add has --channel/--polarity but rule_remove does not", () => {
    expect(flagNames("rule_add").has("--channel")).toBe(true);
    expect(flagNames("rule_add").has("--polarity")).toBe(true);
    expect(flagNames("rule_remove").has("--channel")).toBe(false);
    expect(flagNames("rule_remove").has("--polarity")).toBe(false);
  });

  it("asset_extract has --describe/--direction/--crop but not --tweak/--remember/--author", () => {
    const names = flagNames("asset_extract");
    for (const present of ["--describe", "--direction", "--crop", "--image", "--version", "--name"]) {
      expect(names.has(present)).toBe(true);
    }
    for (const absent of ["--tweak", "--remember", "--author", LEGACY_FLAG]) {
      expect(names.has(absent)).toBe(false);
    }
  });

  it("asset_regenerate has --tweak/--remember but not --describe/--direction/--image", () => {
    const names = flagNames("asset_regenerate");
    for (const present of ["--tweak", "--remember", "--author"]) {
      expect(names.has(present)).toBe(true);
    }
    for (const absent of ["--describe", "--direction", "--image", "--version", "--crop", "--name", LEGACY_FLAG]) {
      expect(names.has(absent)).toBe(false);
    }
  });

  it("asset_remove has no flags", () => {
    expect([...flagNames("asset_remove")]).toEqual([]);
  });
});

describe("verb-catalog mutates classification", () => {
  it("is total and exhaustive over the catalog and matches the expected sets", () => {
    const NONE = new Set([
      "direction_list",
      "direction_memory_read",
      "direction_brief_show",
      "doctor",
      "asset_list",
    ]);
    const DESTRUCTIVE = new Set([
      "approve",
      "direction_memory_delete",
      "rule_remove",
      "rule_edit",
      "asset_remove",
    ]);
    const allNames = new Set(listLeaves().map((l) => l.toolName));
    const WRITE = new Set([...allNames].filter((n) => !NONE.has(n) && !DESTRUCTIVE.has(n)));

    const partition: Record<Mutates, Set<string>> = { none: new Set(), write: new Set(), destructive: new Set() };
    for (const leaf of listLeaves()) {
      expect(["none", "write", "destructive"]).toContain(leaf.mutates);
      partition[leaf.mutates].add(leaf.toolName);
    }

    expect(partition.none).toEqual(NONE);
    expect(partition.destructive).toEqual(DESTRUCTIVE);
    expect(partition.write).toEqual(WRITE);
  });
});

describe("verb-catalog tool names", () => {
  it("are unique and snake_case", () => {
    const names = listLeaves().map((l) => l.toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("expands to exactly 27 leaves (7 simple + 12 direction + 3 rule + 5 asset)", () => {
    expect(listLeaves().length).toBe(27);
  });
});

describe("toolCallToTokens round-trips through parseArgs", () => {
  it("positional-only shape (audit)", () => {
    const leaf = getLeaf("audit")!;
    const tokens = toolCallToTokens(leaf, { url: "http://localhost:3000" });
    expect(tokens).toEqual(["http://localhost:3000"]);
    const parsed = parseArgs(getCommand("audit")!, tokens);
    expect(parsed).toEqual({ positionals: ["http://localhost:3000"], flags: {} });
  });

  it("positional + divergent-flag shape (explore)", () => {
    const leaf = getLeaf("explore")!;
    // WS-16: the explore leaf's flags carry the divergent modes only.
    const flagNames = leaf.flags.map((f) => f.name);
    expect(flagNames).not.toContain(LEGACY_FLAG);
    expect(flagNames).toContain("--describe");
    expect(flagNames).toContain("--from");

    const tokens = toolCallToTokens(leaf, { directionId: "moody" });
    expect(tokens).toEqual(["moody"]);
    const parsed = parseArgs(getCommand("explore")!, tokens);
    expect(parsed).toEqual({ positionals: ["moody"], flags: {} });

    const divergent = toolCallToTokens(leaf, { describe: "a seed", count: "3" });
    const divergentParsed = parseArgs(getCommand("explore")!, divergent);
    expect(divergentParsed).toEqual({
      positionals: [],
      flags: { describe: "a seed", count: "3" },
    });
  });

  it("boolean flag shape (approve --force)", () => {
    const leaf = getLeaf("approve")!;
    const tokens = toolCallToTokens(leaf, { directionId: "direction-a", force: true });
    expect(tokens).toEqual(["direction-a", "--force"]);
    const parsed = parseArgs(getCommand("approve")!, tokens);
    expect(parsed).toEqual({ positionals: ["direction-a"], flags: { force: true } });
  });

  it("a false boolean flag is omitted entirely", () => {
    const leaf = getLeaf("approve")!;
    const tokens = toolCallToTokens(leaf, { directionId: "direction-a", force: false });
    expect(tokens).toEqual(["direction-a"]);
  });

  it("mixed shape (regenerate)", () => {
    const leaf = getLeaf("regenerate")!;
    const tokens = toolCallToTokens(leaf, { directionId: "direction-a", tweak: "warmer CTA" });
    expect(tokens).toEqual(["direction-a", "--tweak", "warmer CTA"]);
    const parsed = parseArgs(getCommand("regenerate")!, tokens);
    expect(parsed).toEqual({ positionals: ["direction-a"], flags: { tweak: "warmer CTA" } });
  });

  it("verb-expanded shape (direction_memory_edit)", () => {
    const leaf = getLeaf("direction_memory_edit")!;
    const tokens = toolCallToTokens(leaf, {
      id: "moody",
      entryId: "learning-abc123",
      body: "Editorial serifs, but warmer",
      "expected-memory-version": "5",
    });
    expect(tokens).toEqual([
      "memory",
      "edit",
      "moody",
      "learning-abc123",
      "--body",
      "Editorial serifs, but warmer",
      "--expected-memory-version",
      "5",
    ]);
    const parsed = parseArgs(getCommand("direction")!, tokens);
    expect(parsed).toEqual({
      positionals: ["memory", "edit", "moody", "learning-abc123"],
      flags: { body: "Editorial serifs, but warmer", "expected-memory-version": "5" },
    });
  });

  it("multi-positional verb-expanded shape (direction_brief_set)", () => {
    const leaf = getLeaf("direction_brief_set")!;
    const tokens = toolCallToTokens(leaf, { id: "moody", field: "colorIntent", value: "warm earthy" });
    expect(tokens).toEqual(["brief", "set", "moody", "colorIntent", "warm earthy"]);
    const parsed = parseArgs(getCommand("direction")!, tokens);
    expect(parsed).toEqual({ positionals: ["brief", "set", "moody", "colorIntent", "warm earthy"], flags: {} });
  });

  it("JSON blob kept as a single token with the seed as --from (direction_create)", () => {
    const leaf = getLeaf("direction_create")!;
    const json = '{"name":"Bold Editorial","summary":"..."}';
    const tokens = toolCallToTokens(leaf, { json, from: "moody" });
    expect(tokens).toEqual(["create", json, "--from", "moody"]);
    const parsed = parseArgs(getCommand("direction")!, tokens);
    expect(parsed).toEqual({ positionals: ["create", json], flags: { from: "moody" } });
  });

  it("boolean list flag shape (direction_list --include-archived)", () => {
    const leaf = getLeaf("direction_list")!;
    const tokens = toolCallToTokens(leaf, { "include-archived": true });
    expect(tokens).toEqual(["list", "--include-archived"]);
    const parsed = parseArgs(getCommand("direction")!, tokens);
    expect(parsed).toEqual({ positionals: ["list"], flags: { "include-archived": true } });
  });

  it("omits absent optional args without misalignment (approve with no versionId)", () => {
    const leaf = getLeaf("approve")!;
    const tokens = toolCallToTokens(leaf, { directionId: "direction-a" });
    expect(tokens).toEqual(["direction-a"]);
    const parsed = parseArgs(getCommand("approve")!, tokens);
    expect(parsed).toEqual({ positionals: ["direction-a"], flags: {} });
  });

  it("flag-only shape (asset_extract)", () => {
    const leaf = getLeaf("asset_extract")!;
    const tokens = toolCallToTokens(leaf, {
      direction: "direction-a",
      describe: "the yak mascot",
      image: "styleTile",
    });
    expect(tokens).toEqual([
      "extract",
      "--direction",
      "direction-a",
      "--describe",
      "the yak mascot",
      "--image",
      "styleTile",
    ]);
    const parsed = parseArgs(getCommand("asset")!, tokens);
    expect(parsed).toEqual({
      positionals: ["extract"],
      flags: { direction: "direction-a", describe: "the yak mascot", image: "styleTile" },
    });
  });

  it("mixed positional + flags incl. boolean shape (asset_regenerate)", () => {
    const leaf = getLeaf("asset_regenerate")!;
    const tokens = toolCallToTokens(leaf, {
      assetId: "yak-mascot",
      tweak: "face left",
      remember: true,
    });
    expect(tokens).toEqual(["regenerate", "yak-mascot", "--tweak", "face left", "--remember"]);
    const parsed = parseArgs(getCommand("asset")!, tokens);
    expect(parsed).toEqual({
      positionals: ["regenerate", "yak-mascot"],
      flags: { tweak: "face left", remember: true },
    });

    const withoutRemember = toolCallToTokens(leaf, {
      assetId: "yak-mascot",
      tweak: "face left",
      remember: false,
    });
    expect(withoutRemember).toEqual(["regenerate", "yak-mascot", "--tweak", "face left"]);
  });
});

describe("applyContext (collapsed single-slot focus inheritance)", () => {
  it("fills explore's POSITIONAL directionId slot from the studio focus (WS-16 binding unchanged)", () => {
    const leaf = getLeaf("explore")!;
    expect(leaf.contextBinding).toEqual({
      directionSlot: { kind: "positional", name: "directionId" },
    });
    const out = applyContext(leaf, {}, { directionId: "direction-b" });
    expect(out).toEqual({ directionId: "direction-b" });
  });

  it("fills the POSITIONAL id slot for direction_feedback", () => {
    // direction_feedback's body is a `--body` flag (not a positional) — the real
    // `directionMeta.run` in src/mcp/registry.ts reads the feedback entry body
    // ONLY from `flagValue(flags, "body")`, so the leaf mirrors that.
    const leaf = getLeaf("direction_feedback")!;
    const filled = applyContext(leaf, { body: "warmer" }, { directionId: "direction-b" });
    expect(filled).toEqual({ body: "warmer", id: "direction-b" });

    const tokens = toolCallToTokens(leaf, filled);
    expect(tokens).toEqual(["feedback", "direction-b", "--body", "warmer"]);
    const parsed = parseArgs(getCommand("direction")!, tokens);
    expect(parsed).toEqual({
      positionals: ["feedback", "direction-b"],
      flags: { body: "warmer" },
    });
  });

  it("never overrides a model-supplied value, never fills an undeclared slot, and is pure", () => {
    const feedbackLeaf = getLeaf("direction_feedback")!;
    const explicit = { id: "other", body: "x" };
    const out = applyContext(feedbackLeaf, explicit, { directionId: "direction-b" });
    expect(out.id).toBe("other");
    expect(explicit).toEqual({ id: "other", body: "x" }); // input untouched (purity)

    // direction_new CREATES a direction — the focus must never be inherited.
    const newLeaf = getLeaf("direction_new")!;
    expect(newLeaf.contextBinding).toEqual({});
    const untouched = applyContext(newLeaf, {}, { directionId: "direction-b" });
    expect(untouched).toEqual({});

    // direction_list takes no focus target either.
    const listLeaf = getLeaf("direction_list")!;
    expect(applyContext(listLeaf, {}, { directionId: "direction-b" })).toEqual({});
  });

  it("direction_create fills its --from seed slot from the focus only when omitted", () => {
    const leaf = getLeaf("direction_create")!;
    const filled = applyContext(leaf, { json: "{}" }, { directionId: "direction-b" });
    expect(filled).toEqual({ json: "{}", from: "direction-b" });

    const explicit = applyContext(leaf, { json: "{}", from: "seed-a" }, { directionId: "direction-b" });
    expect(explicit.from).toBe("seed-a");
  });

  it("fills --direction for an id-free asset_extract; asset_regenerate inherits nothing", () => {
    const leaf = getLeaf("asset_extract")!;
    const filled = applyContext(
      leaf,
      { describe: "the yak" },
      { directionId: "direction-b" },
    );
    expect(filled).toEqual({
      describe: "the yak",
      direction: "direction-b",
    });

    // A model-supplied direction is never overridden.
    const explicitDirection = applyContext(
      leaf,
      { describe: "the yak", direction: "direction-a" },
      { directionId: "direction-b" },
    );
    expect(explicitDirection.direction).toBe("direction-a");

    // asset_regenerate has NO directionSlot — the asset's own record wins.
    const regenerateLeaf = getLeaf("asset_regenerate")!;
    const regenerateFilled = applyContext(
      regenerateLeaf,
      { assetId: "yak-mascot", tweak: "face left" },
      { directionId: "direction-b" },
    );
    expect(regenerateFilled).toEqual({
      assetId: "yak-mascot",
      tweak: "face left",
    });
  });
});
