import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proposeBriefPatch, sanitizeBriefText } from "./brief-map.js";
import { parseBrandBrief, type BrandBrief } from "./schema.js";
import * as openai from "../openai.js";

vi.mock("../openai.js", () => ({
  chatJson: vi.fn(),
  hasApiKey: vi.fn(() => true),
}));

const chatJson = vi.mocked(openai.chatJson);

const EMPTY_BRIEF: BrandBrief = parseBrandBrief({});

/** Any hex token — used to assert no brief field value carries a bare hex. */
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

function mockModel(data: unknown): void {
  chatJson.mockResolvedValue({ data: data as never, dryRun: false });
}

function mockDryRun(): void {
  chatJson.mockResolvedValue({ data: null as never, dryRun: true });
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  chatJson.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proposeBriefPatch", () => {
  it("maps a ramble to fields (dryRun false)", async () => {
    mockModel({
      oneLiner: "A local creative director for AI prototypes",
      tone: ["warm", "confident", "editorial"],
      audiences: [{ who: "solo founders", need: "credibility" }],
    });

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform:
        "It's basically a local creative director for AI prototypes — warm, confident, editorial. Mostly solo founders who need credibility.",
      current: EMPTY_BRIEF,
    });

    expect(proposal.dryRun).toBe(false);
    expect(proposal.patch.oneLiner).toBe(
      "A local creative director for AI prototypes",
    );
    expect(proposal.patch.tone).toEqual(["warm", "confident", "editorial"]);
    expect(proposal.patch.audiences).toEqual([
      { who: "solo founders", need: "credibility" },
    ]);
    expect(proposal.hexLocks).toEqual([]);
  });

  it("returns an empty field patch on dry-run (no key) and never throws", async () => {
    mockDryRun();

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform: "warm, earthy, grounded",
      current: EMPTY_BRIEF,
    });

    expect(proposal.dryRun).toBe(true);
    expect(proposal.patch).toEqual({});
    expect(proposal.hexLocks).toEqual([]);
    // The model entry point is called with no key too — chatJson owns the dry-run.
    expect(chatJson).toHaveBeenCalledOnce();
  });

  it("routes exact hexes to lock suggestions (deduped) and never into a field", async () => {
    // Even when the model tries to smuggle a hex into colorIntent, the sanitizer
    // strips it — the hex reaches memory via the deterministic scan, not the brief.
    mockModel({ colorIntent: "#ff5722 warm and earthy" });

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform:
        "Go warm and earthy, ink is #1a1a1a, the CTA pops with #ff5722 (and #1A1A1A again).",
      current: EMPTY_BRIEF,
    });

    // Deduped (case-insensitive), first-seen order, normalized lower-case.
    expect(proposal.hexLocks.map((l) => l.hex)).toEqual(["#1a1a1a", "#ff5722"]);

    // colorIntent is clean (hex stripped) — no brief field value carries a hex.
    expect(proposal.patch.colorIntent).toBe("warm and earthy");
    for (const value of Object.values(proposal.patch)) {
      const flat = Array.isArray(value) ? value.join(" ") : String(value);
      expect(HEX_RE.test(flat)).toBe(false);
    }
  });

  it("still flags a pasted hex keyless (deterministic scan) while the patch stays empty", async () => {
    mockDryRun();

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform: "lock the brand ink at #1a1a1a",
      current: EMPTY_BRIEF,
    });

    expect(proposal.dryRun).toBe(true);
    expect(proposal.patch).toEqual({});
    expect(proposal.hexLocks.map((l) => l.hex)).toEqual(["#1a1a1a"]);
  });

  it("whitelists — an unknown key does not leak into the patch", async () => {
    mockModel({ colour: "blue", oneLiner: "a real field" });

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform: "make it blue-ish",
      current: EMPTY_BRIEF,
    });

    expect("colour" in proposal.patch).toBe(false);
    expect(proposal.patch.oneLiner).toBe("a real field");
  });

  it("lifts an optional model rationale into notes (not a brief field)", async () => {
    mockModel({ tone: ["calm"], notes: "kept it minimal per the ramble" });

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform: "keep it calm",
      current: EMPTY_BRIEF,
    });

    expect(proposal.notes).toBe("kept it minimal per the ramble");
    expect("notes" in proposal.patch).toBe(false);
  });

  it("never throws when the model read fails — degrades to an empty patch + hex scan", async () => {
    chatJson.mockRejectedValue(new Error("network boom"));

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform: "lock #1a1a1a and go warm",
      current: EMPTY_BRIEF,
    });

    expect(proposal.dryRun).toBe(false);
    expect(proposal.patch).toEqual({});
    expect(proposal.hexLocks.map((l) => l.hex)).toEqual(["#1a1a1a"]);
  });
});

describe("sanitizeBriefText", () => {
  it("strips both a hex and a catalog font family, keeping the intent words", () => {
    const out = sanitizeBriefText("#1a2b3c bold, Bodoni Moda energy");
    expect(out).toContain("bold");
    expect(out).toContain("energy");
    expect(out).not.toMatch(HEX_RE);
    expect(out.toLowerCase()).not.toContain("bodoni moda");
  });

  it("is the sanitize path for buildPatch-driven fields (scalar and array)", async () => {
    mockModel({
      colorIntent: "#1a2b3c bold, Bodoni Moda energy",
      tone: ["Playfair Display refined", "warm #ff5722 glow"],
    });

    const proposal = await proposeBriefPatch({
      model: "gpt-5.5",
      freeform: "irrelevant",
      current: EMPTY_BRIEF,
    });

    expect(proposal.patch.colorIntent).toContain("bold");
    expect(proposal.patch.colorIntent).toContain("energy");
    expect(proposal.patch.colorIntent).not.toMatch(HEX_RE);
    expect(proposal.patch.colorIntent?.toLowerCase()).not.toContain(
      "bodoni moda",
    );
    expect(proposal.patch.tone).toEqual(["refined", "warm glow"]);
  });
});
