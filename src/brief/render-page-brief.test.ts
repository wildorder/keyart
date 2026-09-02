import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DirectionContent, KeyartConfig } from "../types.js";
import { renderPageBrief } from "./render-page-brief.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

vi.mock("../openai.js", () => ({
  hasApiKey: () => false,
  chatJson: vi.fn(),
}));

const SAMPLE_DIRECTION: DirectionContent = {
  name: "Bold & Modern",
  summary:
    "A bold, modern direction emphasizing clean geometry and strong contrast.",
  positioning: "Position the brand as a confident, forward-thinking leader.",
  character: {
    mood: "High-contrast palette, geometric sans-serif typography, generous whitespace, bold accent colors.",
  },
  homepageMockupPrompt:
    "Design a bold, modern homepage mockup with geometric shapes.",
  styleTilePrompt:
    "Create a style tile for a bold, modern brand with color swatches.",
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
};

describe("renderPageBrief", () => {
  it("includes all required sections", () => {
    const output = renderPageBrief({
      pageName: "dashboard",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "",
    });

    expect(output).toContain("# Page Brief: dashboard");
    expect(output).toContain("## Approved direction summary");
    expect(output).toContain("## Visual rules");
    expect(output).toContain("## Anti-rules");
    expect(output).toContain("## Copy tone");
    expect(output).toContain("## Image requirements");
    expect(output).toContain("## Component & style expectations");
    expect(output).toContain("## Implementation checklist");
    expect(output).toContain("## Cursor prompt (paste below)");
  });

  it("contains a fenced Cursor prompt with the pageName", () => {
    const output = renderPageBrief({
      pageName: "dashboard",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "",
    });

    // Extract the fenced code block
    const fenceStart = output.indexOf("```");
    const fenceEnd = output.indexOf("```", fenceStart + 3);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);

    const fencedContent = output.slice(fenceStart + 3, fenceEnd);
    expect(fencedContent).toContain("dashboard");
  });

  it("includes direction summary and positioning", () => {
    const output = renderPageBrief({
      pageName: "home",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "",
    });

    expect(output).toContain(SAMPLE_DIRECTION.summary);
    expect(output).toContain(SAMPLE_DIRECTION.positioning);
  });

  it("includes design rules as bullets", () => {
    const output = renderPageBrief({
      pageName: "home",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "",
    });

    for (const rule of SAMPLE_DIRECTION.usage.rules) {
      expect(output).toContain(`- ${rule}`);
    }
  });

  it("includes anti-rules as bullets", () => {
    const output = renderPageBrief({
      pageName: "home",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "",
    });

    for (const rule of SAMPLE_DIRECTION.usage.antiRules) {
      expect(output).toContain(`- ${rule}`);
    }
  });

  it("renders the direction's character as the Cursor-prompt visual-style summary", () => {
    const multi: DirectionContent = {
      ...SAMPLE_DIRECTION,
      character: {
        mood: "Confident and airy",
        layout: "Twelve-column grid",
        rhythm: "Unhurried pacing",
      },
    };
    const output = renderPageBrief({
      pageName: "home",
      direction: multi,
      styleGuideExcerpt: "",
    });
    // The present character fields are joined into the one-line summary.
    expect(output).toContain(
      "- Visual style: Confident and airy Twelve-column grid Unhurried pacing",
    );
  });

  it("emits no raw #rrggbb — usage/character reference roles, never hexes (SC-02/SC-06)", () => {
    const output = renderPageBrief({
      pageName: "home",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "",
    });
    expect(output).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  it("references style guide in Cursor prompt when excerpt provided", () => {
    const output = renderPageBrief({
      pageName: "pricing",
      direction: SAMPLE_DIRECTION,
      styleGuideExcerpt: "Some guide content here",
    });

    expect(output).toContain("visual style guide");
  });
});

describe("runBrief integration", () => {
  let tmpDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-brief-"));
    delete process.env.OPENAI_API_KEY;

    // Create approved direction
    const approvedDir = path.join(tmpDir, "brand", "approved");
    await fs.mkdir(approvedDir, { recursive: true });
    await fs.writeFile(
      path.join(approvedDir, "current-direction.json"),
      JSON.stringify(SAMPLE_DIRECTION),
      "utf-8",
    );
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

  function mockConfig(): KeyartConfig {
    return {
      project: { name: "Test Project", type: "prototype", framework: "next" },
      brand: {
        root: path.join(tmpDir, "brand"),
        references: path.join(tmpDir, "brand", "input", "references"),
        approved: path.join(tmpDir, "brand", "approved"),
        rejected: path.join(tmpDir, "brand", "rejected"),
      },
      models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
      outputs: {
        cursorRules: path.join(
          tmpDir,
          ".cursor",
          "rules",
          "keyart-brand.mdc",
        ),
        cssVars: path.join(tmpDir, "brand", "generated", "brand.css"),
        implementationBrief: path.join(
          tmpDir,
          "brand",
          "generated",
          "implementation-brief.md",
        ),
      },
    };
  }

  it("dry-run writes the brief file", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(mockConfig());

    const { runBrief } = await import("../commands/brief.js");
    await runBrief({ cwd: tmpDir, pageName: "dashboard", force: true });

    const outPath = path.join(
      tmpDir,
      "brand",
      "generated",
      "page-briefs",
      "dashboard.md",
    );
    const content = await fs.readFile(outPath, "utf-8");
    expect(content).toContain("# Page Brief: dashboard");
    expect(content).toContain("## Cursor prompt (paste below)");
  });

  it("throws CommandError when approved direction is missing", async () => {
    // Remove the approved direction
    await fs.rm(
      path.join(tmpDir, "brand", "approved", "current-direction.json"),
    );

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(mockConfig());

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

    const { runBrief } = await import("../commands/brief.js");
    const { CommandError } = await import("../errors.js");
    await expect(
      runBrief({ cwd: tmpDir, pageName: "dashboard" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runBrief({ cwd: tmpDir, pageName: "dashboard" }),
    ).rejects.toThrow(/approve/);

    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("sanitizes pageName to kebab-case filename", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(mockConfig());

    const { runBrief } = await import("../commands/brief.js");
    await runBrief({ cwd: tmpDir, pageName: "Home Page", force: true });

    const outPath = path.join(
      tmpDir,
      "brand",
      "generated",
      "page-briefs",
      "home-page.md",
    );
    const content = await fs.readFile(outPath, "utf-8");
    expect(content).toContain("# Page Brief: Home Page");
  });

  it("does not crash when style guide is missing", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(mockConfig());

    const { runBrief } = await import("../commands/brief.js");
    // Should not throw even without brand/guides/visual-style-guide.md
    const result = await runBrief({
      cwd: tmpDir,
      pageName: "pricing",
      force: true,
    });
    expect(result.written).toBe(true);
    expect(result.outPath).toBe("brand/generated/page-briefs/pricing.md");
  });
});
