import path from "node:path";
import { loadConfig } from "../config.js";
import { ensureDir, pathExists, readTextFile, writeJsonFile, writeTextFile } from "../fs.js";
import { hasApiKey, visionJson } from "../openai.js";
import { captureUrl } from "../audit/capture-screenshot.js";
import {
  buildPlaceholderAudit,
  parseVisionAudit,
  renderAuditMarkdown,
} from "../audit/render-audit.js";
import type { AuditReport } from "../audit/audit.types.js";
import { createBrandCore } from "../brand/core.js";
import { createDirectionCore } from "../direction/core.js";
import { directionsRoot } from "../config.js";

/**
 * Deterministic, attributed one-line summary of an audit for the approved
 * direction's memory — no model call, so it is stable in dry-run too.
 */
function summarizeAudit(report: AuditReport, auditId: string): string {
  const titles = report.findings.map((f) => f.issue).join("; ");
  const detail = titles.length > 0 ? ` — ${titles}` : "";
  return `Audit of ${report.url} (${auditId}): ${report.findings.length} finding(s)${detail}.`;
}

export interface AuditResult {
  auditId: string;
  auditDir: string;
  dryRun: boolean;
  filesWritten: string[];
}

export async function runAudit(opts: {
  cwd: string;
  url: string;
}): Promise<AuditResult> {
  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = (abs: string): string =>
    path.relative(cwd, abs).split(path.sep).join("/");

  const auditId = new Date().toISOString().replace(/[:.]/g, "-");
  const brandRoot = path.resolve(opts.cwd, config.brand.root);
  const auditDir = path.join(brandRoot, "audits", auditId);
  await ensureDir(auditDir);

  // 1. Capture screenshot
  const screenshotPath = path.join(auditDir, "screenshot.png");
  console.log(`Capturing screenshot of ${opts.url}...`);
  await captureUrl(opts.url, screenshotPath);
  console.log(`Screenshot saved to ${screenshotPath}`);

  // 2. Read style guide if it exists
  const styleGuidePath = path.join(brandRoot, "guides", "visual-style-guide.md");
  let styleGuide: string | null = null;
  if (await pathExists(styleGuidePath)) {
    styleGuide = await readTextFile(styleGuidePath);
  } else {
    console.warn(
      "Warning: brand/guides/visual-style-guide.md not found. Run `keyart approve` first for AI critique.",
    );
  }

  // 3. Run AI critique or placeholder
  let report: AuditReport;

  if (hasApiKey() && styleGuide) {
    const systemPrompt = [
      "You are a visual design auditor. You compare a webpage screenshot against a brand style guide.",
      "Return a JSON object matching the AuditReport schema with fields: url, capturedAt, dryRun (false), summary, findings[].",
      "Each finding must have: id (string), category (brand-consistency|typography|color|layout|copy|other),",
      "severity (critical|major|minor|nit), issue, evidence (what you see in screenshot), suggestedFix,",
      "updateStyleGuide (boolean), updateCursorRules (boolean).",
      "Be specific and actionable. Reference exact elements visible in the screenshot.",
    ].join("\n");

    const userPrompt = [
      `Audit this screenshot of ${opts.url} against the following style guide:`,
      "",
      styleGuide,
    ].join("\n");

    const { data, dryRun } = await visionJson<AuditReport>({
      model: config.models.vision,
      system: systemPrompt,
      imagePath: screenshotPath,
      user: userPrompt,
    });

    if (dryRun || !data) {
      report = buildPlaceholderAudit(opts.url);
    } else {
      report = parseVisionAudit(data);
      report.url = opts.url;
    }
  } else {
    report = buildPlaceholderAudit(opts.url);
  }

  // 4. Write audit artifacts
  const auditJsonPath = path.join(auditDir, "audit.json");
  const auditMdPath = path.join(auditDir, "audit.md");
  await writeJsonFile(auditJsonPath, report);
  await writeTextFile(auditMdPath, renderAuditMarkdown(report));

  console.log(`Audit complete: ${auditDir}`);

  const filesWritten = [
    rel(screenshotPath),
    rel(auditJsonPath),
    rel(auditMdPath),
  ];

  // 5. Roll findings up into the APPROVED direction's memory (deterministic,
  // attributed). Anchored to the single approved direction via the global
  // pointer, so isolation is preserved. Skipped silently when nothing is
  // approved, and a memory-write failure never fails the audit.
  try {
    const pointer = (await createBrandCore(cwd, config).read()).approvedPointer;
    if (pointer) {
      await createDirectionCore(cwd, config).appendLearning(pointer.directionId, {
        body: summarizeAudit(report, auditId),
        author: "audit",
        source: "audit",
      });
      const memoryPath = path.join(
        directionsRoot(cwd, config),
        pointer.directionId,
        "memory.yaml",
      );
      filesWritten.push(rel(memoryPath));
      console.log(
        `  ✓ rolled audit findings into direction "${pointer.directionId}" memory`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: could not roll audit into direction memory: ${reason}`);
  }

  return {
    auditId,
    auditDir: rel(auditDir),
    dryRun: report.dryRun,
    filesWritten,
  };
}
