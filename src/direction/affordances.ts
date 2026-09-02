import type { RuleSeverity } from "../brand/schema.js";

/**
 * Derived, pure per-signal action affordances for the studio's Edit/Promote/
 * Delete controls — the server (this module + `src/ui/api.ts`) stays the
 * single authority; the UI never re-derives policy. Called ONLY on ACTIVE
 * signals (retired signals are dropped from the active dashboard arrays
 * before this runs), so `editable`/`deletable`/`removable` are always true —
 * they exist to name the affordance, not gate it. Kept dependency-light (no
 * core/command imports) so neither the CLI/MCP result rendering nor the
 * studio UI pulls the heavy command module into the browser bundle.
 */

export function memoryEntryAffordances(_e: {
  retiredAt?: string;
  supersededBy?: string;
}): {
  editable: boolean;
  deletable: boolean;
  /** Promote is up-only and single-destination now that scope is location —
   *  a direction entry may only be lifted straight to global (no demote, no
   *  intermediate scope to widen into). */
  promotableTo: ("global")[];
} {
  return {
    editable: true,
    deletable: true,
    promotableTo: ["global"],
  };
}

export function assetAffordances(_a: { retiredAt?: string }): {
  removable: boolean;
} {
  // Kept-crop assets are NEVER promotable across scopes — only a retire
  // affordance applies.
  return { removable: true };
}

export function ruleAffordances(_r: {
  retiredAt?: string;
  severity: RuleSeverity;
}): {
  editable: boolean;
  removable: boolean;
} {
  // A hard rule still offers both controls — the `force` requirement is
  // enforced at write time by `BrandCore.editRule`/`removeRule`, not hidden here.
  return { editable: true, removable: true };
}
