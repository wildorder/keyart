import { z } from "zod";

/** The CLOSED v1 slot vocabulary. Keyart owns this enum — host agents author
 *  CONTENT against it, never structure. It grows only by recorded `other` evidence. */
export const SLOT_KINDS = [
  "icon",
  "illustration",
  "color-role",
  "type-role",
  "other",
] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** Slot ids are dot-namespaced kebab-case: `<family>.<name>` with at least two
 *  segments, each starting with a letter (e.g. "icon.restaurant",
 *  "color-role.chart-accent"). */
export const SLOT_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Teaching error map: an unknown kind names the five valid kinds. */
export const SlotKindSchema = z.enum(SLOT_KINDS, {
  errorMap: (_issue, ctx) => ({
    message: `Unknown kind ${JSON.stringify(ctx.data)} — valid kinds: ${SLOT_KINDS.join(", ")}.`,
  }),
});

/** A single attributed demand signal. Attribution (author/source/date) is REQUIRED. */
export const SlotAttributionSchema = z.object({
  author: z.string(),
  source: z.string(), // e.g. "cli" | "mcp" | "studio" | "scan"
  date: z.string(), // ISO 8601
});
export type SlotAttribution = z.infer<typeof SlotAttributionSchema>;

/** The six semantic roles a slot may sit on — no accent. */
export const SlotSitsOnSchema = z.enum([
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
]);
export type SlotSitsOn = z.infer<typeof SlotSitsOnSchema>;

export const SlotContextSchema = z.object({
  sitsOn: SlotSitsOnSchema.optional(),
  sizes: z.array(z.number().int().positive()).optional(), // px, e.g. [16, 24]
  usedIn: z.array(z.string()).optional(), // e.g. ["nav", "empty-state"]
  tone: z.string().optional(), // e.g. "friendly, rounded"
  note: z.string().optional(), // free text; REQUIRED BY CONVENTION on kind "other"
});
export type SlotContext = z.infer<typeof SlotContextSchema>;

export const SurfaceSlotSchema = z.object({
  id: z
    .string()
    .refine(
      (v) => SLOT_ID_RE.test(v),
      (v) => ({
        message: `Invalid slot id ${JSON.stringify(v)} — ids are dot-namespaced kebab-case: <family>.<name> (e.g. "icon.restaurant").`,
      }),
    ),
  kind: SlotKindSchema,
  description: z.string().min(1),
  context: SlotContextSchema.optional(),
  criticality: z.enum(["required", "preferred"]),
  origin: z.enum(["authored", "scan", "request"]),
  attributions: z.array(SlotAttributionSchema).default([]),
  /** NON-DESTRUCTIVE retire marker (mirrors MemoryEntry.retiredAt /
   *  AssetRef.retiredAt / GlobalRule.retiredAt). ISO 8601. Absent ⇒ live. A
   *  retired slot drops from every default read (show/bind/gap/board);
   *  history stays. Set only by SurfaceCore.retireSlot. */
  retiredAt: z.string().optional(),
});
export type SurfaceSlot = z.infer<typeof SurfaceSlotSchema>;

export const SurfaceManifestSchema = z
  .object({
    version: z.number().int().nonnegative(),
    updatedAt: z.string(), // ISO 8601
    slots: z.array(SurfaceSlotSchema).default([]),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const slot of manifest.slots) {
      if (seen.has(slot.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate slot id "${slot.id}" — slot ids are unique; to add demand for an existing slot, append an attribution (surface request) instead of a second slot.`,
        });
      }
      seen.add(slot.id);
    }
  });
export type SurfaceManifest = z.infer<typeof SurfaceManifestSchema>;

export const parseSurfaceManifest = (raw: unknown): SurfaceManifest =>
  SurfaceManifestSchema.parse(raw);

/** Renders a ZodError as one `- <path>: <message>` line per issue — the
 *  `loadConfig` issue-formatting idiom, so CLI/MCP/studio surface identical
 *  teaching text. */
export function formatTeachingIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length ? issue.path.join(".") : "(root)";
      return `- ${at}: ${issue.message}`;
    })
    .join("\n");
}

/** True iff the slot resolves to a generated ASSET (bind/fill territory) rather
 *  than a token-derived value. */
export function isAssetSlot(slot: Pick<SurfaceSlot, "kind">): boolean {
  return slot.kind === "icon" || slot.kind === "illustration";
}

/** True iff the slot carries the non-destructive retire marker. */
export function isSlotRetired(slot: { retiredAt?: string }): boolean {
  return typeof slot.retiredAt === "string" && slot.retiredAt.length > 0;
}

/** Slot lookup by id — includes retired slots (callers filter with isSlotRetired). */
export function slotById(
  manifest: SurfaceManifest,
  slotId: string,
): SurfaceSlot | undefined {
  return manifest.slots.find((s) => s.id === slotId);
}

/**
 * The JSON Schema published by `surface schema` (WS-02) and embedded in the
 * scan brief. HAND-MAINTAINED in lockstep with the Zod schemas above — Zod v3
 * has no `z.toJSONSchema`, and adding `zod-to-json-schema` would violate the
 * no-new-runtime-dependency invariant. References `SLOT_KINDS`/`SLOT_ID_RE.source`
 * directly (never re-typed literals) so the enum and pattern can never drift
 * from the Zod truth.
 */
export const SURFACE_MANIFEST_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SurfaceManifest",
  type: "object",
  required: ["version", "updatedAt", "slots"],
  properties: {
    version: { type: "integer", minimum: 0 },
    updatedAt: { type: "string", description: "ISO 8601" },
    slots: { type: "array", items: { $ref: "#/definitions/SurfaceSlot" } },
  },
  definitions: {
    SurfaceSlot: {
      type: "object",
      required: [
        "id",
        "kind",
        "description",
        "criticality",
        "origin",
        "attributions",
      ],
      properties: {
        id: {
          type: "string",
          pattern: SLOT_ID_RE.source,
          description:
            'Dot-namespaced kebab-case: <family>.<name> (e.g. "icon.restaurant").',
        },
        kind: { enum: [...SLOT_KINDS] },
        description: { type: "string", minLength: 1 },
        context: { $ref: "#/definitions/SlotContext" },
        criticality: { enum: ["required", "preferred"] },
        origin: { enum: ["authored", "scan", "request"] },
        attributions: {
          type: "array",
          items: { $ref: "#/definitions/SlotAttribution" },
        },
        retiredAt: { type: "string", description: "ISO 8601" },
      },
    },
    SlotContext: {
      type: "object",
      properties: {
        sitsOn: {
          enum: ["background", "surface", "text", "muted", "primary", "secondary"],
        },
        sizes: { type: "array", items: { type: "integer", minimum: 1 } },
        usedIn: { type: "array", items: { type: "string" } },
        tone: { type: "string" },
        note: { type: "string" },
      },
    },
    SlotAttribution: {
      type: "object",
      required: ["author", "source", "date"],
      properties: {
        author: { type: "string" },
        source: { type: "string" },
        date: { type: "string", description: "ISO 8601" },
      },
    },
  },
} as const;
