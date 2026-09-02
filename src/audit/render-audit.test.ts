import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AuditReport } from "./audit.types.js";
import {
  buildPlaceholderAudit,
  parseVisionAudit,
  renderAuditMarkdown,
} from "./render-audit.js";

describe("buildPlaceholderAudit", () => {
  it("returns dryRun: true with non-empty summary", () => {
    const report = buildPlaceholderAudit("http://localhost:3000");
    expect(report.dryRun).toBe(true);
    expect(report.url).toBe("http://localhost:3000");
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("includes placeholder findings with valid structure", () => {
    const report = buildPlaceholderAudit("http://example.com");
    for (const f of report.findings) {
      expect(f.id).toBeTruthy();
      expect(f.category).toBeTruthy();
      expect(f.severity).toBeTruthy();
      expect(f.issue).toBeTruthy();
      expect(f.suggestedFix).toBeTruthy();
    }
  });
});

describe("parseVisionAudit", () => {
  const validFixture: AuditReport = {
    url: "http://localhost:3000",
    capturedAt: "2026-01-01T00:00:00.000Z",
    dryRun: false,
    summary: "The page has several brand inconsistencies.",
    findings: [
      {
        id: "f-1",
        category: "color",
        severity: "major",
        issue: "Primary button uses wrong brand color",
        evidence: "The CTA button is #ff0000 instead of the brand blue #0066cc",
        suggestedFix: "Update button background to var(--brand-primary)",
        updateStyleGuide: false,
        updateCursorRules: true,
      },
      {
        id: "f-2",
        category: "typography",
        severity: "minor",
        issue: "Body text uses system font instead of brand font",
        evidence: "Paragraph text renders in Arial instead of Inter",
        suggestedFix: "Ensure @font-face is loaded and applied to body",
        updateStyleGuide: false,
        updateCursorRules: false,
      },
    ],
  };

  it("parses valid fixture into typed report", () => {
    const report = parseVisionAudit(validFixture);
    expect(report.url).toBe("http://localhost:3000");
    expect(report.dryRun).toBe(false);
    expect(report.summary).toBe("The page has several brand inconsistencies.");
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0].id).toBe("f-1");
    expect(report.findings[0].category).toBe("color");
    expect(report.findings[1].severity).toBe("minor");
  });

  it("handles missing findings gracefully", () => {
    const report = parseVisionAudit({ url: "http://test.com", summary: "ok" });
    expect(report.findings).toEqual([]);
    expect(report.dryRun).toBe(false);
  });

  it("handles completely empty input", () => {
    const report = parseVisionAudit({});
    expect(report.url).toBe("");
    expect(report.findings).toEqual([]);
  });
});

describe("renderAuditMarkdown", () => {
  it("includes summary and findings", () => {
    const report: AuditReport = {
      url: "http://localhost:3000",
      capturedAt: "2026-01-01T00:00:00.000Z",
      dryRun: false,
      summary: "Found 2 issues.",
      findings: [
        {
          id: "f-1",
          category: "color",
          severity: "critical",
          issue: "Wrong brand color",
          evidence: "Button is red",
          suggestedFix: "Use blue",
          updateStyleGuide: true,
          updateCursorRules: false,
        },
      ],
    };

    const md = renderAuditMarkdown(report);
    expect(md).toContain("# Audit Report");
    expect(md).toContain("Found 2 issues.");
    expect(md).toContain("Wrong brand color");
    expect(md).toContain("Critical");
    expect(md).toContain("Button is red");
    expect(md).toContain("Use blue");
    expect(md).toContain("Style guide may need updating");
  });

  it("shows 'No findings' when findings array is empty", () => {
    const report: AuditReport = {
      url: "http://test.com",
      capturedAt: "2026-01-01T00:00:00.000Z",
      dryRun: true,
      summary: "Nothing found.",
      findings: [],
    };

    const md = renderAuditMarkdown(report);
    expect(md).toContain("No findings.");
  });

  it("includes dry run indicator", () => {
    const report = buildPlaceholderAudit("http://test.com");
    const md = renderAuditMarkdown(report);
    expect(md).toContain("**Dry Run:** Yes");
  });
});

describe("runAudit dry-run integration", () => {
  let tmpDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-audit-"));
    delete process.env.OPENAI_API_KEY;
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

  it("writes audit.json and audit.md in dry-run mode", async () => {
    // Mock playwright so we don't need a real browser
    vi.mock("playwright", () => ({
      chromium: {
        launch: vi.fn().mockResolvedValue({
          newPage: vi.fn().mockResolvedValue({
            goto: vi.fn().mockResolvedValue(undefined),
            screenshot: vi.fn().mockImplementation(async (opts: { path: string }) => {
              // Write a fake PNG file
              await fs.mkdir(path.dirname(opts.path), { recursive: true });
              await fs.writeFile(opts.path, "fake-png-data");
            }),
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
      },
    }));

    // Mock config
    vi.mock("../config.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../config.js")>();
      return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
    });

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue({
      project: { name: "Test", type: "prototype", framework: "next" },
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
    });

    const { runAudit } = await import("../commands/audit.js");
    await runAudit({ cwd: tmpDir, url: "http://localhost:3000" });

    // Find the audit directory
    const auditsDir = path.join(tmpDir, "brand", "audits");
    const entries = await fs.readdir(auditsDir);
    expect(entries.length).toBe(1);

    const auditDir = path.join(auditsDir, entries[0]);

    // Check screenshot exists
    const screenshotExists = await fs.access(path.join(auditDir, "screenshot.png")).then(() => true, () => false);
    expect(screenshotExists).toBe(true);

    // Check audit.json
    const auditJson = JSON.parse(
      await fs.readFile(path.join(auditDir, "audit.json"), "utf-8"),
    ) as AuditReport;
    expect(auditJson.dryRun).toBe(true);
    expect(auditJson.url).toBe("http://localhost:3000");
    expect(auditJson.findings.length).toBeGreaterThan(0);

    // Check audit.md
    const auditMd = await fs.readFile(path.join(auditDir, "audit.md"), "utf-8");
    expect(auditMd).toContain("# Audit Report");
    expect(auditMd).toContain("http://localhost:3000");
  });
});
