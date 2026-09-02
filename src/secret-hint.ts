/**
 * Mask a secret for display. Shows a short prefix and the last 4 chars so the
 * user can recognize their key without exposing it. Short/empty values are
 * fully masked. Never returns the full secret.
 *   maskSecret("sk-proj-abc...B3k9") => "sk-…B3k9"
 *   maskSecret("short")              => "•••••" (all bullets)
 *   maskSecret("")                   => "(none)"
 */
export function maskSecret(value: string): string {
  if (value === "") return "(none)";
  if (value.length <= 8) return "•".repeat(value.length);
  return value.slice(0, 3) + "…" + value.slice(-4);
}
