import { createSingleDocStore } from "../store/create-store.js";
import type { SingleDocStore } from "../store/versioned-store.js";
import { surfaceManifestPath, storeDriver } from "../config.js";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { z } from "zod";
import {
  SurfaceManifestSchema,
  SurfaceSlotSchema,
  parseSurfaceManifest,
  formatTeachingIssues,
  type SurfaceManifest,
  type SurfaceSlot,
  type SlotAttribution,
} from "./schema.js";

/** Options accepted by every SurfaceCore write. */
export interface SurfaceWriteOptions {
  expectedVersion?: number;
  force?: boolean;
}

/** The three slot origins, derived from the Zod enum so they can never drift from
 *  `SurfaceSlotSchema` (the SLOT_ID_RE.source precedent — never a re-typed literal). */
export const SLOT_ORIGINS = SurfaceSlotSchema.shape.origin.options;
export type SlotOrigin = (typeof SLOT_ORIGINS)[number]; // "authored" | "scan" | "request"

/** The slot shape a consuming agent submits via `requestSlot` — origin and
 *  attribution are stamped by the core, never caller-supplied. */
export type RequestedSlot = Omit<SurfaceSlot, "origin" | "attributions" | "retiredAt">;

/** The fields `editSlot` may amend. The id is immutable; retire is its own verb. */
export type SlotPatch = Partial<
  Pick<SurfaceSlot, "kind" | "description" | "context" | "criticality">
>;

export interface SurfaceCore {
  /** The manifest, or null when brand/surface.yaml has never been written — the
   *  program's "no manifest" state (approve/studio treat null as feature-off).
   *  Reads NEVER write. */
  read(): Promise<SurfaceManifest | null>;
  /** Wholesale replace of the slots array (the Lane-2 bulk-authoring write).
   *  Creates the manifest on first call. */
  setManifest(slots: SurfaceSlot[], opts?: SurfaceWriteOptions): Promise<SurfaceManifest>;
  /** Upsert by slot id: an existing id is replaced with the incoming slot (in
   *  place, manifest order preserved); a new id is appended (patch order). */
  patchSlots(patches: SurfaceSlot[], opts?: SurfaceWriteOptions): Promise<SurfaceManifest>;
  /** The miss-becomes-a-write protocol. Dedupes by slot id: an existing id
   *  appends `attribution` to that slot (never a duplicate slot, other fields
   *  untouched — including retiredAt); a new id appends a slot with
   *  origin "request" and attributions [attribution]. */
  requestSlot(
    slot: RequestedSlot,
    attribution: SlotAttribution,
    opts?: SurfaceWriteOptions,
  ): Promise<{ manifest: SurfaceManifest; slotId: string; deduped: boolean }>;
  /** Amends kind/description/context/criticality. Unknown id ⇒ CommandError;
   *  retired id ⇒ CommandError (a retired slot is history). */
  editSlot(
    slotId: string,
    patch: SlotPatch,
    opts?: SurfaceWriteOptions,
  ): Promise<SurfaceManifest>;
  /** The house non-destructive retire: sets retiredAt (ISO now). Idempotent —
   *  already retired ⇒ no-op, no write, no version bump. Unknown id ⇒
   *  CommandError, writing nothing. */
  retireSlot(
    slotId: string,
    opts?: SurfaceWriteOptions,
  ): Promise<{ manifest: SurfaceManifest; retiredAt: string; alreadyRetired: boolean }>;
  /** BULK bad-scan recovery: the house non-destructive retire applied to every
   *  ACTIVE slot of one origin, in ONE versioned write, sharing ONE retiredAt
   *  timestamp so the batch is identifiable. IDEMPOTENT — zero active matches ⇒
   *  no-op, no write, no version bump (the retireSlot/removeRule precedent).
   *  STRICTLY origin-scoped: slots of every other origin are byte-untouched.
   *  Nothing is ever deleted. No manifest at all ⇒ CommandError, writing nothing. */
  retireSlotsByOrigin(
    origin: SlotOrigin,
    opts?: SurfaceWriteOptions,
  ): Promise<{
    manifest: SurfaceManifest;
    retiredIds: string[];
    alreadyRetiredCount: number;
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Validates `next` and rethrows a ZodError as the house teaching CommandError. */
function parseOrTeach(next: unknown): SurfaceManifest {
  try {
    return SurfaceManifestSchema.parse(next);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new CommandError(formatTeachingIssues(err));
    }
    throw err;
  }
}

export function createSurfaceCore(
  cwd: string,
  config: KeyartConfig,
): SurfaceCore {
  const store: SingleDocStore<SurfaceManifest> = createSingleDocStore({
    driver: storeDriver(config),
    filePath: surfaceManifestPath(cwd, config),
    parse: parseSurfaceManifest,
  });

  async function writeSlots(
    slots: SurfaceSlot[],
    current: SurfaceManifest | null,
    opts?: SurfaceWriteOptions,
  ): Promise<SurfaceManifest> {
    const next = parseOrTeach({
      version: current?.version ?? 0,
      updatedAt: nowIso(),
      slots,
    });
    return store.write(next, {
      expectedVersion: opts?.expectedVersion ?? current?.version ?? 0,
      force: opts?.force,
    });
  }

  const core: SurfaceCore = {
    async read() {
      return store.read();
    },

    async setManifest(slots, opts) {
      const current = await store.read();
      return writeSlots(slots, current, opts);
    },

    async patchSlots(patches, opts) {
      const current = await store.read();
      const slots = [...(current?.slots ?? [])];
      for (const patch of patches) {
        const idx = slots.findIndex((s) => s.id === patch.id);
        if (idx === -1) {
          slots.push(patch);
        } else {
          slots[idx] = patch;
        }
      }
      return writeSlots(slots, current, opts);
    },

    async requestSlot(slot, attribution, opts) {
      const current = await store.read();
      const slots = [...(current?.slots ?? [])];
      const idx = slots.findIndex((s) => s.id === slot.id);
      let deduped: boolean;
      if (idx === -1) {
        slots.push({
          ...slot,
          origin: "request",
          attributions: [attribution],
        });
        deduped = false;
      } else {
        slots[idx] = {
          ...slots[idx],
          attributions: [...slots[idx].attributions, attribution],
        };
        deduped = true;
      }
      const manifest = await writeSlots(slots, current, opts);
      return { manifest, slotId: slot.id, deduped };
    },

    async editSlot(slotId, patch, opts) {
      const current = await store.read();
      const existing = current?.slots.find((s) => s.id === slotId);
      if (!existing) {
        throw new CommandError(`Slot not found: ${slotId}.`);
      }
      if (existing.retiredAt !== undefined) {
        throw new CommandError(
          `Cannot edit retired slot ${slotId}. A retired slot is history — recreate it instead.`,
        );
      }
      const slots = current!.slots.map((s) =>
        s.id === slotId ? { ...s, ...patch } : s,
      );
      return writeSlots(slots, current, opts);
    },

    async retireSlot(slotId, opts) {
      const current = await store.read();
      const existing = current?.slots.find((s) => s.id === slotId);
      if (!existing) {
        throw new CommandError(`Slot not found: ${slotId}.`);
      }
      if (existing.retiredAt !== undefined) {
        return {
          manifest: current!,
          retiredAt: existing.retiredAt,
          alreadyRetired: true,
        };
      }
      const retiredAt = nowIso();
      const slots = current!.slots.map((s) =>
        s.id === slotId ? { ...s, retiredAt } : s,
      );
      const manifest = await writeSlots(slots, current, opts);
      return { manifest, retiredAt, alreadyRetired: false };
    },

    async retireSlotsByOrigin(origin, opts) {
      const current = await store.read();
      if (!current) {
        throw new CommandError(
          "No surface manifest yet (brand/surface.yaml) — nothing to retire. " +
            "Author one with `surface schema` + `surface set`, or run `surface scan --apply` first.",
        );
      }

      const matching = current.slots.filter((s) => s.origin === origin);
      const alreadyRetiredCount = matching.filter(
        (s) => s.retiredAt !== undefined,
      ).length;
      const targets = matching.filter((s) => s.retiredAt === undefined);

      // Idempotent: nothing active to retire ⇒ no-op, no write, no version bump.
      if (targets.length === 0) {
        return { manifest: current, retiredIds: [], alreadyRetiredCount };
      }

      const retiredAt = nowIso();
      const targetIds = new Set(targets.map((s) => s.id));
      const slots = current.slots.map((s) =>
        targetIds.has(s.id) ? { ...s, retiredAt } : s,
      );
      const manifest = await writeSlots(slots, current, opts);
      return {
        manifest,
        retiredIds: targets.map((s) => s.id),
        alreadyRetiredCount,
      };
    },
  };

  return core;
}
