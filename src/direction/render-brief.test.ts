import { describe, it, expect } from "vitest";
import { renderBrief } from "./render-brief.js";
import { parseBrandBrief } from "./schema.js";

describe("renderBrief", () => {
  it("is deterministic — same input renders byte-identically", () => {
    const brief = parseBrandBrief({
      oneLiner: "A local creative director.",
      tone: ["warm", "confident"],
      colorIntent: "warm earthy",
    });
    const a = renderBrief(brief);
    const b = renderBrief(brief);
    expect(a).toBe(b);

    const brief2 = parseBrandBrief({
      oneLiner: "A local creative director.",
      tone: ["warm", "confident"],
      colorIntent: "warm earthy",
    });
    expect(renderBrief(brief2)).toBe(a);
  });

  it("ends with exactly one trailing newline", () => {
    const out = renderBrief(parseBrandBrief({ oneLiner: "hi" }));
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("omits empty sections and fields — only-oneLiner renders one line, no empty headers", () => {
    const out = renderBrief(parseBrandBrief({ oneLiner: "Just a tagline." }));
    expect(out).toContain("Just a tagline.");
    expect(out).toContain("## Identity");
    expect(out).not.toContain("## Strategy");
    expect(out).not.toContain("## Personality");
    expect(out).not.toContain("## Aesthetic intent");
    expect(out).not.toContain("## Grounding");
    expect(out).not.toContain("## Notes");
  });

  it("renders the stable placeholder for an all-empty brief (no headers)", () => {
    const out = renderBrief(parseBrandBrief({}));
    expect(out).toBe(
      "_No brief yet. Describe this direction's audience, problem, tone, and aesthetic intent._\n",
    );
    expect(out).not.toContain("## ");
  });

  it("emits NO document H1 — section headings are `##`+", () => {
    const brief = parseBrandBrief({
      oneLiner: "x",
      problem: "y",
      tone: ["z"],
      colorIntent: "warm",
      inspirations: ["a"],
      otherNotes: "notes",
    });
    const out = renderBrief(brief);
    for (const line of out.split("\n")) {
      expect(/^# /.test(line)).toBe(false);
    }
    expect(out).toContain("## Identity");
    expect(out).toContain("## Aesthetic intent");
  });

  it("labels the aesthetic-intent section as SOFT intent", () => {
    const out = renderBrief(
      parseBrandBrief({ colorIntent: "warm earthy", typeIntent: "humanist sans" }),
    );
    expect(out).toContain("## Aesthetic intent");
    expect(out).toMatch(/soft intent/i);
    expect(out).toContain("**Color intent:** warm earthy");
    expect(out).toContain("**Type intent:** humanist sans");
    expect(out.toLowerCase().indexOf("soft intent")).toBeLessThan(
      out.indexOf("Color intent"),
    );
  });

  it("renders audiences with optional context/need suffixes only when present", () => {
    const out = renderBrief(
      parseBrandBrief({
        audiences: [
          { who: "indie devs", context: "shipping fast", need: "coherent brand" },
          { who: "PMs" },
        ],
      }),
    );
    expect(out).toContain("- indie devs — shipping fast (need: coherent brand)");
    expect(out).toContain("- PMs");
    expect(out).not.toContain("- PMs —");
    expect(out).not.toContain("- PMs (need:");
  });

  it("renders arrays as bullet lists under their labels", () => {
    const out = renderBrief(parseBrandBrief({ tone: ["warm", "confident"] }));
    expect(out).toContain("**Tone:**\n- warm\n- confident");
  });
});
