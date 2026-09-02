import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  DirectionContent,
  KeyartConfig,
  DirectionTokens,
} from "../types.js";
import type { GlobalRule } from "../brand/schema.js";
import {
  renderVisualStyleGuide,
  renderBrandGuide,
  renderCursorRules,
  renderImagePrompts,
  renderImplementationBrief,
  renderBrandCss,
  resolveBrandVars,
  APPROXIMATE_FONT_NOTE,
  type SourceStamp,
  type GuideSurface,
  type GuideSurfaceSlotRow,
} from "./render-guides.js";

/** A complete, six-role token set with distinctive, non-default hexes. */
const SAMPLE_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "Primary", hex: "#3b1e5e" },
    { role: "secondary", name: "Secondary", hex: "#7a4fb5" },
    { role: "background", name: "Background", hex: "#fbf9ff" },
    { role: "surface", name: "Surface", hex: "#efe9f7" },
    { role: "text", name: "Text", hex: "#1c1030" },
    { role: "muted", name: "Muted", hex: "#6b5b83" },
  ],
  typography: { heading: "Fraunces", body: "Nunito Sans", scale: 1.25 },
  shape: { radius: "14px", spacingUnit: "6px" },
};

const TOKENED_DIRECTION: DirectionContent = {
  name: "Token Direction",
  summary: "A tokened direction with structured palette + typography.",
  positioning: "Positioning prose.",
  character: { mood: "warm earthy prose that would MISMATCH the tokens if used" },
  homepageMockupPrompt: "Homepage prompt.",
  styleTilePrompt: "Style tile prompt.",
  copyExamples: { headline: "H", subheadline: "S", cta: "C" },
  usage: { rules: ["Rule one", "Rule two", "Rule three"], antiRules: ["Anti one"] },
  tokens: SAMPLE_TOKENS,
};

const SAMPLE_STAMP: SourceStamp = {
  directionId: "direction-a",
  versionId: "2026-06-30T00-00-00-000Z",
  approvedAt: "2026-06-30T00-00-00.000Z",
};

const HARD_RULE: GlobalRule = {
  id: "rule-1",
  severity: "hard",
  text: "No pure black",
  author: "test",
  source: "test",
  date: "2026-06-30T00:00:00.000Z",
};

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const SAMPLE_DIRECTION: DirectionContent = {
  name: "Bold & Modern",
  summary: "A bold, modern direction emphasizing clean geometry and strong contrast.",
  positioning: "Position the brand as a confident, forward-thinking leader.",
  character: { mood: "High-contrast palette, geometric sans-serif typography, generous whitespace, bold accent colors." },
  homepageMockupPrompt: "Design a bold, modern homepage mockup with geometric shapes.",
  styleTilePrompt: "Create a style tile for a bold, modern brand with color swatches.",
  copyExamples: {
    headline: "Built for what comes next",
    subheadline: "A modern platform designed with clarity and confidence.",
    cta: "Get started",
  },
  usage: {
    rules: [
      "Use a maximum of 3 brand colors plus neutrals",
      "Maintain at least 4:1 contrast ratio on all text",
      "Use geometric sans-serif for headings, neutral sans-serif for body",
      "Keep layouts grid-aligned with consistent 8px spacing",
    ],
    antiRules: [
      "Never use more than two typefaces on a single page",
      "Avoid rounded or playful shapes — keep geometry sharp",
      "Do not use gradients except as subtle background accents",
    ],
  },
  tokens: SAMPLE_TOKENS,
};

const SAMPLE_PROJECT: KeyartConfig["project"] = {
  name: "Test Project",
  type: "prototype",
  framework: "next",
};

describe("renderVisualStyleGuide", () => {
  it("contains direction name", () => {
    const output = renderVisualStyleGuide(SAMPLE_DIRECTION);
    expect(output).toContain(SAMPLE_DIRECTION.name);
  });

  it("contains at least 3 design rules as bullets", () => {
    const output = renderVisualStyleGuide(SAMPLE_DIRECTION);
    const ruleLines = output.split("\n").filter((line) => line.startsWith("- "));
    expect(ruleLines.length).toBeGreaterThanOrEqual(3);
  });

  it("contains positioning and visual style sections", () => {
    const output = renderVisualStyleGuide(SAMPLE_DIRECTION);
    expect(output).toContain(SAMPLE_DIRECTION.positioning);
    expect(output).toContain(SAMPLE_DIRECTION.character.mood!);
  });
});

describe("renderBrandGuide", () => {
  it("contains direction name and summary", () => {
    const output = renderBrandGuide(SAMPLE_DIRECTION);
    expect(output).toContain(SAMPLE_DIRECTION.name);
    expect(output).toContain(SAMPLE_DIRECTION.summary);
  });

  it("contains copy examples", () => {
    const output = renderBrandGuide(SAMPLE_DIRECTION);
    expect(output).toContain(SAMPLE_DIRECTION.copyExamples.headline);
    expect(output).toContain(SAMPLE_DIRECTION.copyExamples.cta);
  });
});

describe("renderCursorRules", () => {
  it("contains imperative verbs and anti-rules section", () => {
    const output = renderCursorRules(SAMPLE_DIRECTION, SAMPLE_PROJECT);
    // Check for imperative language from the direction's rules
    const hasImperative = /never|use|keep|maintain|avoid|do not/i.test(output);
    expect(hasImperative).toBe(true);
    expect(output).toContain("Anti-Rules (Never Do This)");
  });

  it("includes project name", () => {
    const output = renderCursorRules(SAMPLE_DIRECTION, SAMPLE_PROJECT);
    expect(output).toContain(SAMPLE_PROJECT.name);
  });

  it("carries a token legend with semantic roles and hue-named brand handles", () => {
    const withBrand: DirectionContent = {
      ...TOKENED_DIRECTION,
      tokens: {
        ...SAMPLE_TOKENS,
        brand: [
          { hex: "#ff2d8d", name: "pink", label: "Hot Pink" },
          { hex: "#00b3a4", name: "teal" },
        ],
      },
    };
    const output = renderCursorRules(withBrand, SAMPLE_PROJECT);
    // Semantic roles are listed by function so an agent picks by intent.
    expect(output).toContain("### Token legend");
    expect(output).toContain("`var(--brand-primary)`");
    // The unbounded primitives resolve a "use the pink" request to a real var.
    expect(output).toContain("`var(--brand-pink)` = `#ff2d8d` (Hot Pink)");
    expect(output).toContain("`var(--brand-teal)` = `#00b3a4`");
    // Six semantic roles only — the seventh `accent` role was dropped (SC-06).
    expect(output).toContain("`var(--brand-text-muted)`");
    expect(output).not.toContain("--brand-accent");
  });

  it("omits the brand-handle list when the direction has no brand set", () => {
    const output = renderCursorRules(TOKENED_DIRECTION, SAMPLE_PROJECT);
    expect(output).toContain("### Token legend");
    expect(output).not.toContain("Brand palette handles");
  });

  it("has frontmatter with description and globs", () => {
    const output = renderCursorRules(SAMPLE_DIRECTION, SAMPLE_PROJECT);
    expect(output).toContain("---");
    expect(output).toContain("description:");
    expect(output).toContain("globs:");
  });
});

describe("renderImagePrompts", () => {
  it("contains both style tile and homepage mockup prompts", () => {
    const output = renderImagePrompts(SAMPLE_DIRECTION);
    expect(output).toContain(SAMPLE_DIRECTION.styleTilePrompt);
    expect(output).toContain(SAMPLE_DIRECTION.homepageMockupPrompt);
  });
});

describe("renderImplementationBrief", () => {
  it("contains project name and direction name", () => {
    const output = renderImplementationBrief(SAMPLE_DIRECTION, SAMPLE_PROJECT);
    expect(output).toContain(SAMPLE_PROJECT.name);
    expect(output).toContain(SAMPLE_DIRECTION.name);
  });
});

describe("structured character + usage projection (WS-04)", () => {
  const MULTI_CHARACTER: DirectionContent = {
    ...SAMPLE_DIRECTION,
    character: {
      mood: "Confident and airy",
      composition: "Asymmetric, anchored to the left rail",
      layout: "Twelve-column grid with generous gutters",
      rhythm: "Steady, unhurried pacing",
      // imagery/texture intentionally absent — must not emit empty lines.
    },
    usage: {
      rules: ["Use --brand-text for body copy, never a raw hex"],
      antiRules: ["Never tint --brand-surface below AA contrast"],
    },
  };

  it("renders each present character field as a labeled line, omitting absent ones", () => {
    const out = renderVisualStyleGuide(MULTI_CHARACTER);
    expect(out).toContain("- **Mood:** Confident and airy");
    expect(out).toContain("- **Composition:** Asymmetric, anchored to the left rail");
    expect(out).toContain("- **Layout:** Twelve-column grid with generous gutters");
    expect(out).toContain("- **Rhythm:** Steady, unhurried pacing");
    // Absent fields produce no dangling label.
    expect(out).not.toContain("**Imagery:**");
    expect(out).not.toContain("**Texture:**");
  });

  it("carries the character block across every codified guide", () => {
    const project = SAMPLE_PROJECT;
    for (const out of [
      renderVisualStyleGuide(MULTI_CHARACTER),
      renderBrandGuide(MULTI_CHARACTER),
      renderCursorRules(MULTI_CHARACTER, project),
      renderImplementationBrief(MULTI_CHARACTER, project),
    ]) {
      expect(out).toContain("- **Mood:** Confident and airy");
    }
  });

  it("renders usage.rules/antiRules verbatim and never the removed field names", () => {
    const out = renderVisualStyleGuide(MULTI_CHARACTER);
    expect(out).toContain("- Use --brand-text for body copy, never a raw hex");
    expect(out).toContain("- Never tint --brand-surface below AA contrast");
    // The retired freeform placeholders are gone from the emitted artifact.
    expect(out).not.toContain("{{visualStyle}}");
    expect(out).not.toContain("{{designRulesList}}");
    expect(out).not.toContain("{{antiRulesList}}");
    expect(out).not.toContain("{{character}}");
  });

  it("leaks no raw #rrggbb into a usage/character projection (roles only)", () => {
    // The visual-style guide + implementation brief carry no palette legend, so a
    // hex here could only leak from a usage rule or character field (SC-02/SC-06).
    expect(renderVisualStyleGuide(MULTI_CHARACTER)).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(
      renderImplementationBrief(MULTI_CHARACTER, SAMPLE_PROJECT),
    ).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe("renderBrandCss", () => {
  it("produces valid CSS with brand variables", () => {
    const output = renderBrandCss(SAMPLE_DIRECTION);
    expect(output).toContain("--brand-primary:");
    expect(output).toContain("--brand-font-heading:");
    expect(output).toContain("--brand-radius:");
    expect(output).toContain(":root {");
  });

  it("is deterministic for the same input", () => {
    const a = renderBrandCss(SAMPLE_DIRECTION);
    const b = renderBrandCss(SAMPLE_DIRECTION);
    expect(a).toBe(b);
  });

  it("derives every --brand-* value from tokens when present (not the keyword hack)", () => {
    const output = renderBrandCss(TOKENED_DIRECTION);
    // Palette hexes come straight from the tokens…
    expect(output).toContain("--brand-primary: #3b1e5e;");
    expect(output).toContain("--brand-secondary: #7a4fb5;");
    expect(output).toContain("--brand-background: #fbf9ff;");
    expect(output).toContain("--brand-surface: #efe9f7;");
    expect(output).toContain("--brand-text: #1c1030;");
    // `muted` role → --brand-text-muted.
    expect(output).toContain("--brand-text-muted: #6b5b83;");
    // …fonts reference the token families in the fallback stack…
    expect(output).toContain(
      "--brand-font-heading: 'Fraunces', system-ui, sans-serif;",
    );
    expect(output).toContain(
      "--brand-font-body: 'Nunito Sans', system-ui, sans-serif;",
    );
    // …shape comes from the tokens…
    expect(output).toContain("--brand-radius: 14px;");
    expect(output).toContain("--brand-spacing-unit: 6px;");
    // …and the "warm" prose keyword hack is NOT consulted (its #1a1a2e / #c1666b
    // defaults never appear).
    expect(output).not.toContain("#1a1a2e");
    expect(output).not.toContain("#c1666b");
  });

  it("emits hue-named brand primitives (with label comments) when tokens carry a brand set", () => {
    const withBrand: DirectionContent = {
      ...TOKENED_DIRECTION,
      tokens: {
        ...SAMPLE_TOKENS,
        brand: [
          { hex: "#3b1e5e", name: "violet", label: "Deep Violet" },
          { hex: "#f2a900", name: "orange" },
          { hex: "#7a4fb5", name: "purple", label: "Grape" },
        ],
      },
    };
    const output = renderBrandCss(withBrand);
    expect(output).toContain("/* Brand primitives");
    // Hue-named handles at the same hexes; the model label rides as a comment.
    expect(output).toContain("--brand-violet: #3b1e5e; /* Deep Violet */");
    expect(output).toContain("--brand-orange: #f2a900;");
    expect(output).toContain("--brand-purple: #7a4fb5; /* Grape */");
    // The semantic role contract is untouched and still present.
    expect(output).toContain("--brand-primary: #3b1e5e;");
  });

  it("emits NO primitives block when tokens have no brand set (byte-compat)", () => {
    const output = renderBrandCss(TOKENED_DIRECTION);
    expect(output).not.toContain("Brand primitives");
    // Empty brand set leaves the color→typography spacing byte-identical.
    expect(output).toContain("--brand-text-muted: #6b5b83;\n\n  /* Typography */");
  });

  it("throws a helpful error for a token-less direction (tokens are required)", () => {
    const legacy: DirectionContent = { ...SAMPLE_DIRECTION };
    delete (legacy as { tokens?: unknown }).tokens;
    expect(() => renderBrandCss(legacy)).toThrow(/no structured tokens/);
  });

  it("is byte-identical across renders for a tokened direction (deterministic)", () => {
    expect(renderBrandCss(TOKENED_DIRECTION)).toBe(
      renderBrandCss(TOKENED_DIRECTION),
    );
    expect(renderBrandCss(TOKENED_DIRECTION, SAMPLE_STAMP)).toBe(
      renderBrandCss(TOKENED_DIRECTION, SAMPLE_STAMP),
    );
  });
});

describe("approximate-font honesty label", () => {
  it("labels the extracted-token CSS fonts approximate without touching the var contract", () => {
    const output = renderBrandCss(TOKENED_DIRECTION);
    // The honesty label is present, as a CSS comment near the typography vars.
    expect(output).toContain(`/* ${APPROXIMATE_FONT_NOTE} */`);
    // The var names/values are UNCHANGED by the label (contract byte-stable):
    // strip every comment line and the font vars are exactly the token stacks.
    expect(output).toContain(
      "--brand-font-heading: 'Fraunces', system-ui, sans-serif;",
    );
    expect(output).toContain(
      "--brand-font-body: 'Nunito Sans', system-ui, sans-serif;",
    );
    // The label lives above the vars, so the emitted var lines are byte-identical
    // to a hand-written contract (no inline annotation on the var line itself).
    expect(output).toContain(
      "\n  --brand-font-heading: 'Fraunces', system-ui, sans-serif;",
    );
  });

});

describe("resolveBrandVars", () => {
  it("returns the exact token hexes/families for a tokened direction", () => {
    const vars = resolveBrandVars(TOKENED_DIRECTION);
    expect(vars.primary).toBe("#3b1e5e");
    expect(vars.textMuted).toBe("#6b5b83");
    expect(vars.fontHeadingFamily).toBe("Fraunces");
    expect(vars.fontBodyFamily).toBe("Nunito Sans");
    expect(vars.fontHeading).toBe("'Fraunces', system-ui, sans-serif");
    expect(vars.radius).toBe("14px");
    expect(vars.spacingUnit).toBe("6px");
    // No brand set on these tokens → empty primitive layer.
    expect(vars.brand).toEqual([]);
  });

  it("surfaces the brand primitive layer from tokens.brand", () => {
    const withBrand: DirectionContent = {
      ...TOKENED_DIRECTION,
      tokens: {
        ...SAMPLE_TOKENS,
        brand: [{ hex: "#3b1e5e", name: "violet", label: "Deep Violet" }],
      },
    };
    expect(resolveBrandVars(withBrand).brand).toEqual([
      { hex: "#3b1e5e", name: "violet", label: "Deep Violet" },
    ]);
  });

  it("throws for a token-less direction (tokens are the required source)", () => {
    const legacy: DirectionContent = { ...SAMPLE_DIRECTION };
    delete (legacy as { tokens?: unknown }).tokens;
    expect(() => resolveBrandVars(legacy)).toThrow(/no structured tokens/);
  });
});

describe("provenance stamp", () => {
  it("renderVisualStyleGuide begins with the source stamp when given one", () => {
    const output = renderVisualStyleGuide(SAMPLE_DIRECTION, { stamp: SAMPLE_STAMP });
    expect(output.startsWith("<!-- Source: direction=direction-a")).toBe(true);
    expect(output).toContain(
      "direction=direction-a version=2026-06-30T00-00-00-000Z",
    );
  });

  it("renders byte-identical to the no-arg form when no stamp is given", () => {
    expect(renderVisualStyleGuide(SAMPLE_DIRECTION, {})).toBe(
      renderVisualStyleGuide(SAMPLE_DIRECTION),
    );
    expect(renderVisualStyleGuide(SAMPLE_DIRECTION)).not.toContain("<!-- Source:");
  });

  it("stamps the cursor .mdc under the frontmatter, not before it", () => {
    const output = renderCursorRules(SAMPLE_DIRECTION, SAMPLE_PROJECT, {
      stamp: SAMPLE_STAMP,
    });
    // Frontmatter still opens the file; the stamp lives inside the body.
    expect(output.startsWith("---")).toBe(true);
    expect(output).toContain("<!-- Source: direction=direction-a");
    const frontmatterEnd = output.indexOf("\n---", 3) + 1;
    expect(output.indexOf("<!-- Source:")).toBeGreaterThan(frontmatterEnd);
  });

  it("stamps brand.css with a /* Source: ... */ header comment", () => {
    const output = renderBrandCss(SAMPLE_DIRECTION, SAMPLE_STAMP);
    expect(output).toContain("/* Source: direction=direction-a version=2026-06-30T00-00-00-000Z");
    expect(renderBrandCss(SAMPLE_DIRECTION)).not.toContain("/* Source:");
  });
});

describe("hard-rule injection", () => {
  it("renders a non-negotiable section before the design rules", () => {
    const output = renderCursorRules(SAMPLE_DIRECTION, SAMPLE_PROJECT, {
      stamp: SAMPLE_STAMP,
      hardRules: [HARD_RULE],
    });
    expect(output).toContain("Non-Negotiable Global Rules");
    expect(output).toContain("No pure black");
    // Placed before the direction-derived design rules.
    expect(output.indexOf("No pure black")).toBeLessThan(
      output.indexOf("## Design Rules"),
    );
  });

  it("adds no non-negotiable section when hardRules is empty", () => {
    const output = renderCursorRules(SAMPLE_DIRECTION, SAMPLE_PROJECT, {
      hardRules: [],
    });
    expect(output).not.toContain("Non-Negotiable Global Rules");
  });
});

describe("runApprove integration", () => {
  let tmpDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-approve-"));
    delete process.env.OPENAI_API_KEY;

    // Seed the versioned direction store:
    // directions/direction-a/versions/<versionId>/…
    const { createDirectionCore } = await import("../direction/core.js");
    const { mintVersionId, writeVersion } = await import(
      "../direction/store.js"
    );
    const core = createDirectionCore(tmpDir, mockConfig());
    await core.create({ id: "direction-a", name: "Direction A" });

    const directionId = "direction-a";
    const versionDir = path.join(
      tmpDir,
      "brand",
      "directions",
      directionId,
      "versions",
    );
    const versionId = await mintVersionId(versionDir);
    await fs.mkdir(versionDir, { recursive: true });

    const version = {
      ...SAMPLE_DIRECTION,
      id: versionId,
      createdAt: "2026-06-30T00:00:00.000Z",
      briefSnapshot: "brief snapshot",
      contextSnapshot: "context snapshot",
    };
    await writeVersion(path.join(versionDir, versionId), directionId, versionId, version);
    await fs.writeFile(
      path.join(versionDir, versionId, "style-tile-prompt.md"),
      SAMPLE_DIRECTION.styleTilePrompt,
      "utf-8",
    );
    await fs.writeFile(
      path.join(versionDir, versionId, "homepage-mockup-prompt.md"),
      SAMPLE_DIRECTION.homepageMockupPrompt,
      "utf-8",
    );
    await core.appendVersion(directionId, versionId);

    // Create expected output dirs
    await fs.mkdir(path.join(tmpDir, "brand", "approved"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "brand", "guides"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "brand", "generated"), { recursive: true });
  });

  afterEach(async () => {
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockConfig() {
    return {
      project: SAMPLE_PROJECT,
      brand: {
        root: path.join(tmpDir, "brand"),
        references: path.join(tmpDir, "brand", "input", "references"),
        approved: path.join(tmpDir, "brand", "approved"),
        rejected: path.join(tmpDir, "brand", "rejected"),
      },
      models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
      outputs: {
        cursorRules: path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
        cssVars: path.join(tmpDir, "brand", "generated", "brand.css"),
        implementationBrief: path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      },
    } satisfies KeyartConfig;
  }

  it("dry-run creates all output files and current-direction.json matches source", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(mockConfig());

    const { runApprove } = await import("../commands/approve.js");
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    // Check current-direction.json
    const approvedRaw = await fs.readFile(
      path.join(tmpDir, "brand", "approved", "current-direction.json"),
      "utf-8",
    );
    const approved = JSON.parse(approvedRaw);
    // The approved file is a DirectionVersion — its `id` is the pinned versionId.
    expect(typeof approved.id).toBe("string");
    expect(approved.provenance.versionId).toBe(approved.id);
    expect(approved.name).toBe(SAMPLE_DIRECTION.name);

    // Check guides exist with content
    const visualGuide = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "visual-style-guide.md"),
      "utf-8",
    );
    expect(visualGuide.length).toBeGreaterThan(0);
    expect(visualGuide).toContain(SAMPLE_DIRECTION.name);

    const brandGuide = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "brand-guide.md"),
      "utf-8",
    );
    expect(brandGuide.length).toBeGreaterThan(0);

    // Check generated artifacts
    const imagePrompts = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "image-prompts.md"),
      "utf-8",
    );
    expect(imagePrompts.length).toBeGreaterThan(0);

    const implBrief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(implBrief.length).toBeGreaterThan(0);

    const css = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "brand.css"),
      "utf-8",
    );
    expect(css).toContain("--brand-primary:");

    // Check cursor rules at config path
    const cursorRules = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    expect(cursorRules.length).toBeGreaterThan(0);

    // Check cursor rules duplicate in brand/generated
    const cursorRulesDup = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "cursor-brand.mdc"),
      "utf-8",
    );
    expect(cursorRulesDup).toBe(cursorRules);

    // Check copied prompts
    const styleTile = await fs.readFile(
      path.join(tmpDir, "brand", "approved", "style-tile-prompt.md"),
      "utf-8",
    );
    expect(styleTile).toBe(SAMPLE_DIRECTION.styleTilePrompt);
  });

  it("fails with helpful message when direction does not exist", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(mockConfig());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const { runApprove } = await import("../commands/approve.js");
    const { CommandError } = await import("../errors.js");
    await expect(
      runApprove({
        cwd: tmpDir,
        directionId: "nonexistent",
      }),
    ).rejects.toThrow(CommandError);
    await expect(
      runApprove({
        cwd: tmpDir,
        directionId: "nonexistent",
      }),
    ).rejects.toThrow(/direction-a/);

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("cursor rules path respects config.outputs.cursorRules", async () => {
    const config = mockConfig();
    const customPath = path.join(tmpDir, "custom-rules", "brand.mdc");
    config.outputs.cursorRules = customPath;

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(config);

    const { runApprove } = await import("../commands/approve.js");
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    const cursorRules = await fs.readFile(customPath, "utf-8");
    expect(cursorRules).toContain(SAMPLE_DIRECTION.name);
  });
});

describe("surface bindings + request protocol (surface-manifest WS-07)", () => {
  const BOUND_ASSET_ROW: GuideSurfaceSlotRow = {
    id: "icon.restaurant",
    kind: "icon",
    status: "bound",
    file: "brand/generated/asset-pack/direction-a/icon-restaurant.png",
    svgFile: "brand/generated/asset-pack/direction-a/icon-restaurant.svg",
    origin: "authored",
    attributionCount: 0,
  };
  const DERIVED_COLOR_ROW: GuideSurfaceSlotRow = {
    id: "color.rating-star",
    kind: "color-role",
    status: "derived",
    value: "#e8a13c",
    origin: "authored",
    attributionCount: 0,
  };
  const REQUEST_GAP_ROW: GuideSurfaceSlotRow = {
    id: "icon.scooter",
    kind: "icon",
    status: "gap",
    origin: "request",
    attributionCount: 3,
  };
  const OTHER_GAP_ROW: GuideSurfaceSlotRow = {
    id: "pattern.hero-texture",
    kind: "other",
    status: "gap",
    origin: "authored",
    attributionCount: 0,
    note: "tiling background texture",
  };

  const CUSTOM_BINDING_PATH = "brand/generated/custom-binding-path.json";

  const SAMPLE_SURFACE: GuideSurface = {
    bindingPath: CUSTOM_BINDING_PATH,
    rows: [BOUND_ASSET_ROW, DERIVED_COLOR_ROW, REQUEST_GAP_ROW, OTHER_GAP_ROW],
  };

  const ALL_BOUND_SURFACE: GuideSurface = {
    bindingPath: "brand/generated/binding.json",
    rows: [BOUND_ASSET_ROW, DERIVED_COLOR_ROW],
  };

  it("absent surface is byte-identical (Test 1)", () => {
    const briefOpts = { stamp: SAMPLE_STAMP, hardRules: [HARD_RULE] };
    const brief1 = renderImplementationBrief(TOKENED_DIRECTION, SAMPLE_PROJECT, briefOpts);
    const brief2 = renderImplementationBrief(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      ...briefOpts,
      surface: undefined,
    });
    expect(brief2).toBe(brief1);
    expect(brief1).not.toContain("Surface Bindings");
    expect(brief1).not.toContain("Surface Requests");

    const cursor1 = renderCursorRules(TOKENED_DIRECTION, SAMPLE_PROJECT, briefOpts);
    const cursor2 = renderCursorRules(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      ...briefOpts,
      surface: undefined,
    });
    expect(cursor2).toBe(cursor1);
    expect(cursor1).not.toContain("Surface Bindings");
    expect(cursor1).not.toContain("Surface Requests");
  });

  it("the bindings table renders every row shape (Test 2)", () => {
    const brief = renderImplementationBrief(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      surface: SAMPLE_SURFACE,
    });

    expect(brief).toContain("## Surface Bindings (slot → value)");
    // The interpolated bindingPath round-trips — nothing hardcoded.
    expect(brief).toContain(`\`${CUSTOM_BINDING_PATH}\``);

    // A table row per slot with the right Status cell.
    expect(brief).toContain(
      "| `icon.restaurant` | icon | bound | `brand/generated/asset-pack/direction-a/icon-restaurant.png` (+ svg) |",
    );
    expect(brief).toContain(
      "| `color.rating-star` | color-role | derived | `#e8a13c` |",
    );
    expect(brief).toContain("| `icon.scooter` | icon | gap | — |");
    expect(brief).toContain("| `pattern.hero-texture` | other | gap | — |");

    // The gaps list: request-origin + attribution count, taxonomy demand.
    expect(brief).toContain("`icon.scooter` — icon, origin: request, requested 3×");
    expect(brief).toContain(
      '`pattern.hero-texture` — other (taxonomy demand): "tiling background texture"',
    );

    // Zero-gap input renders the honest single line.
    const allBoundBrief = renderImplementationBrief(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      surface: ALL_BOUND_SURFACE,
    });
    expect(allBoundBrief).toContain("- None — every slot resolved.");
  });

  it("the protocol section is exact and identical between brief and cursor rules (Test 3)", () => {
    const brief = renderImplementationBrief(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      surface: SAMPLE_SURFACE,
    });
    const cursor = renderCursorRules(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      surface: SAMPLE_SURFACE,
    });

    for (const out of [brief, cursor]) {
      expect(out).toContain("## Surface Requests (when a brand element is missing)");
      expect(out).toContain(
        'keyart_brand { command: "surface", input: ["request", "<json>"] }',
      );
      expect(out).toContain("icon, illustration, color-role, type-role, other");
      expect(out).toContain("NEVER ship an improvised off-brand value.");
    }

    // One protocol, taught twice — byte-identical bullets in both artifacts.
    // The brief's protocol section is followed by "## References"; the
    // cursor's is the last thing in the body — so extract up to the next
    // heading (or end of string) rather than comparing full tails.
    const extractProtocol = (text: string): string => {
      const start = text.indexOf("## Surface Requests");
      const rest = text.slice(start);
      const nextHeading = rest.indexOf("\n## ");
      return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trimEnd();
    };
    expect(extractProtocol(brief)).toBe(extractProtocol(cursor));
  });

  it("sections render with a manifest even when every slot is bound (Test 4)", () => {
    const brief = renderImplementationBrief(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      surface: ALL_BOUND_SURFACE,
    });
    const cursor = renderCursorRules(TOKENED_DIRECTION, SAMPLE_PROJECT, {
      surface: ALL_BOUND_SURFACE,
    });
    for (const out of [brief, cursor]) {
      expect(out).toContain("## Surface Bindings (slot → value)");
      expect(out).toContain("## Surface Requests (when a brand element is missing)");
      expect(out).toContain("- None — every slot resolved.");
    }
  });
});
