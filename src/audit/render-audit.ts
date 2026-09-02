import type { AuditFinding, AuditReport } from "./audit.types.js";

export function buildPlaceholderAudit(url: string): AuditReport {
  return {
    url,
    capturedAt: new Date().toISOString(),
    dryRun: true,
    summary:
      "AI critique was skipped (no API key or style guide missing). Review the screenshot manually.",
    findings: [
      {
        id: "placeholder-1",
        category: "brand-consistency",
        severity: "major",
        issue: "Automated brand-consistency check was not performed.",
        evidence: "Screenshot captured but not analysed by AI.",
        suggestedFix: "Set OPENAI_API_KEY and ensure brand/guides/visual-style-guide.md exists, then re-run the audit.",
        updateStyleGuide: false,
        updateCursorRules: false,
      },
      {
        id: "placeholder-2",
        category: "other",
        severity: "minor",
        issue: "Manual review recommended.",
        evidence: "No AI analysis available for this audit.",
        suggestedFix: "Open the screenshot and compare it against your style guide visually.",
        updateStyleGuide: false,
        updateCursorRules: false,
      },
    ],
  };
}

export function parseVisionAudit(data: unknown): AuditReport {
  const obj = data as Record<string, unknown>;

  const findings = Array.isArray(obj.findings)
    ? (obj.findings as AuditFinding[])
    : [];

  return {
    url: String(obj.url ?? ""),
    capturedAt: String(obj.capturedAt ?? new Date().toISOString()),
    dryRun: false,
    summary: String(obj.summary ?? ""),
    findings,
  };
}

function severityBadge(severity: string): string {
  const badges: Record<string, string> = {
    critical: "🔴 Critical",
    major: "🟠 Major",
    minor: "🟡 Minor",
    nit: "🔵 Nit",
  };
  return badges[severity] ?? severity;
}

export function renderAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];

  lines.push("# Audit Report");
  lines.push("");
  lines.push(`- **URL:** ${report.url}`);
  lines.push(`- **Captured:** ${report.capturedAt}`);
  lines.push(`- **Dry Run:** ${report.dryRun ? "Yes" : "No"}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(report.summary);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push("## Findings");
    lines.push("");

    for (const f of report.findings) {
      lines.push(`### ${severityBadge(f.severity)} — ${f.issue}`);
      lines.push("");
      lines.push(`- **ID:** ${f.id}`);
      lines.push(`- **Category:** ${f.category}`);
      lines.push(`- **Evidence:** ${f.evidence}`);
      lines.push(`- **Suggested Fix:** ${f.suggestedFix}`);
      if (f.updateStyleGuide) lines.push("- ⚠️ Style guide may need updating");
      if (f.updateCursorRules) lines.push("- ⚠️ Cursor rules may need updating");
      lines.push("");
    }
  }

  return lines.join("\n");
}
