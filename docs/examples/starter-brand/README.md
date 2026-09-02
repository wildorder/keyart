# Example: starter-brand ("Mossling")

**Status: complete.** The genuine generated artifacts — style tile, homepage
mockup, palette/type board, `brand.css`, guides, cursor rules, and studio
screenshots — are all present, from one recorded keyed run on 2026-08-10. See
`RUN.md` for the verbatim transcript and per-file checksums.

> **Note on the transcript.** `RUN.md` is a verbatim record of that run —
> untouched apart from the clearly-marked editorial note at its top. It was
> recorded on a pre-release build and predates the removal of the
> legacy-migration scaffold, so its `init` output still lists
> `brand/input/brief.md` and `brand/silos/default/*` — paths current `init` no
> longer creates. The generated artifacts themselves are unaffected: none of
> those files fed generation. The transcript will be replaced whole the next
> time the example is regenerated.

## What this is

A single, real, end-to-end example of what Keyart produces, generated from
one recorded keyed run against a fictional product brief — **not** a real
brand, company, or person. Nothing here is hand-edited, retouched, or
assembled; if a run looked bad it was re-run, never touched up.

## The fictional product

**Mossling** — an indoor-plant care app that tells you what your plant needs
today. Chosen for being concrete enough to brief, visually rich, and safely
generic.

**Fernlight**, the first candidate, was checked and **rejected**: a web search
on 2026-08-09 turned up multiple real, currently-registered companies using
that exact name (UK Companies House records for "Fernlight Ltd" and "Fernlight
Living Limited", and "FernLight GmbH" in Germany). A name that collides with a
real organization is not used here, even when the real company is in an
unrelated business.

**Mossling** was then checked and cleared on **2026-08-09**:

- Web search for `"Mossling" app OR company OR trademark` and
  `"Mossling" company-information.service.gov.uk OR crunchbase OR "Ltd" OR "Inc"`
  returned no matching app, company, or trademark record.
- `https://registry.npmjs.org/fernlight` and `https://registry.npmjs.org/mossling`
  both returned `404 Not Found` — neither name is a published npm package.

## The input

`brief.json` — a `concept brief patch` payload, validated against
`BrandBriefSchema` (`src/concept/schema.ts`). It carries soft intent only
(words: tone, color intent, type intent) — never hex codes or font family
names; those come from the model's own read of the generated imagery, not the
brief.

## Reproducing (owner-only — spends real money)

```
node scripts/generate-example.mjs --yes
```

The key is read from `.env.local` at the repo root through the project's own
`loadEnvFiles` loader — the same place `keyart init` writes it — or from a
real `OPENAI_API_KEY` environment variable, which takes precedence.

Recommended for a first real run — add `--keep` so the temp project survives
for the byte-identity check and so
`scripts/capture-studio-screenshots.mjs --project <the printed temp dir>` can
reuse it directly instead of reconstructing a stand-in project:

```
node scripts/generate-example.mjs --yes --keep
```

**Expected spend:** `explore --count 3` generates 3 style tiles + 3 homepage
mockups (six image-model calls), plus the text model (direction generation)
and vision model (token extraction from each generated tile) calls that
`explore` and `approve` make along the way. The exact dollar cost depends on
current OpenAI pricing — check your account's usage page after the run.

**Expected duration:** a few minutes (dominated by the six image-generation
calls).

**What to eyeball before the artifacts are committed:** the script prints all
three generated direction ids and picks the first by default — re-run with
`--direction <id>` to pick a different one. Look at the style tile and
homepage mockup for each candidate direction: does it look like a genuine,
coherent brand exploration (not garbled, not a broken/empty image, no
watermark or real company likeness)? If a result looks bad, **re-run the whole
script** — never hand-edit a generated image. The script itself refuses to
proceed on a missing/dry-run artifact (see "Safety" below), but visual quality
is a human judgment call the script cannot make for you.

**Safety:** the script refuses to run without `OPENAI_API_KEY`, refuses to run
without an explicit `--yes` (printing the cost warning first, making zero
model calls), always works in a temp project outside this repo, discovers the
direction id from disk (never hard-codes one), cleans up the temp project in a
`finally` (unless `--keep`), and exits non-zero with the failing command's
output on any error.

## Screenshots (keyless, against the static build)

After the artifacts above are committed, capture the studio screenshots
against the **prebuilt static build** (never the dev server):

```
npm run build
node scripts/capture-studio-screenshots.mjs --project <the kept temp dir>
```

This is keyless throughout (`OPENAI_API_KEY` is deleted from the child
environment at `scripts/capture-studio-screenshots.mjs:204` even if present in
your shell) and asserts the served page came from the static build by checking
for a hashed `/assets/*-<hash>.js` path — the dev server never emits one.

---

## Run record

- **Package version:** `keyart` v0.1.1 (a pre-release build carrying that
  never-shipped version number — the first published release is v0.1.0; see
  the transcript note in `RUN.md`)
- **Run date:** 2026-08-10T04:04:44Z (wall-clock duration 502.2s)
- **Model ids used:** text `gpt-5.5`, vision `gpt-5.5`, image `gpt-image-2` —
  resolved from `DEFAULT_MODELS` at run time, recorded in `RUN.md`
- **Directions generated:** 3 — `windowlight-botanist`,
  `terracotta-care-ledger`, `quiet-growth-system`. **Approved:**
  `quiet-growth-system` (the script's default, the first discovered).
- **Approximate spend:** 6 image-model calls (3 style tiles + 3 homepage
  mockups) plus the text and vision calls `explore`/`approve` make. Dollar cost
  depends on current OpenAI pricing.
- **Static-build proof:** the capture asserted and printed
  `Static-build check passed: /assets/index-CA2lg5wF.js found in the served
  HTML.` That hash matches the `vite build` output for this commit
  (`dist/ui/assets/index-CA2lg5wF.js`), so the screenshots are of the shipped
  static bundle served by `keyart serve` with **no** `--dev`.
- **Genuineness verification:** all 11 copied artifacts were byte-compared
  (`cmp`) against their sources in the run's temp project and are **identical**;
  their sha256 values match the table in `RUN.md`. No direction name matched
  the keyless placeholder set. Every image was viewed: no garbled output, no
  watermark, no real-company likeness.
- **Deterministic-tier consistency:** every one of the 7 hex values in
  `brand.css` appears in both `palette-type-board.svg` and
  `palette-type-board.md` — the projections agree, so nothing was hand-edited.
- **Total committed size:** 4.47 MB (images 4.43 MB: `style-tile.png` 1410 KB,
  `homepage-mockup.png` 1501 KB, `studio-imagery.png` 886 KB,
  `studio-workspace.png` 618 KB, `studio-palette.png` 124 KB). The two generated
  PNGs are 2.91 MB on their own and must not be recompressed (that would break
  byte-identity with the run). Note that `docs/` is not in `package.json`
  `files`, so **none of this ships in the npm tarball** — the cost is git
  history and GitHub README load time only. If the total needs to come down, the
  available
  lever is re-capturing the three screenshots (1.59 MB) at a lower viewport or
  as JPEG; the generated artifacts are fixed.

**Point-in-time snapshot.** Once generated, everything under
`docs/examples/starter-brand/` is a snapshot from one specific run. Nothing
here is regenerated automatically — not in CI, not in `npm test`, not in
`prepublishOnly`. Refreshing it is a deliberate, owner-invoked action (re-run
`generate-example.mjs`), never an automatic one.
