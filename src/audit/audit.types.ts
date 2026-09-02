export type AuditSeverity = "critical" | "major" | "minor" | "nit";

export interface AuditFinding {
  id: string;
  category: "brand-consistency" | "typography" | "color" | "layout" | "copy" | "other";
  severity: AuditSeverity;
  issue: string;
  evidence: string; // what is visible in screenshot
  suggestedFix: string;
  updateStyleGuide: boolean;
  updateCursorRules: boolean;
}

export interface AuditReport {
  url: string;
  capturedAt: string;
  dryRun: boolean;
  summary: string;
  findings: AuditFinding[];
}
