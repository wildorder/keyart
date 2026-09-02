# Run Transcript — starter-brand

> **Editorial note (the only post-run edit in this file).** This transcript was
> recorded on a **pre-release build** that carried the `0.1.1` version number
> (the first published release is `0.1.0` — that number was never shipped). It
> predates the removal of the legacy-migration scaffold, so the `init` output
> below still lists `brand/input/brief.md` and `brand/silos/default/*` — paths
> current `init` no longer creates — and ends with "Edit
> brand/concepts/default/brief.md", advice that no longer applies (the brief is
> authored with `direction brief set`, and `brief.md` is a generated
> projection). The generated artifacts themselves are
> unaffected: none of those files fed generation. Everything below this note is
> verbatim.

Produced by `scripts/generate-example.mjs` on 2026-08-10T04:04:44.234Z using `keyart` v0.1.1.
Wall-clock duration: 502.2s.

Resolved models (`keyart.config.ts` merged with the package's `DEFAULT_MODELS` at run
time — read at run time, not copied from source): text=`gpt-5.5`,
vision=`gpt-5.5`, image=`gpt-image-2`.

Selected direction: `quiet-growth-system` (default: first discovered direction).

The commands ran, in order, in a temporary consuming project created with `fs.mkdtemp`
under the OS temp dir (never inside this repo) with `keyart` linked into its
`node_modules`. The temp path is redacted below as `<tmp>`.

## Commands

### 1. `node bin/keyart.js --cwd <tmp> init --yes`

- exit code: 0
- duration: 1185ms

<details><summary>stdout</summary>

```
Created:
  + keyart.config.ts
  + brand/input/brief.md
  + brand/silos/default/brief.md
  + brand/silos/default/status.json
  + brand/concepts/default/concept.yaml
  + brand/concepts/default/memory.yaml
  + brand/concepts/default/brief.md
  + brand/brand.yaml
  + .env.keyart.example
  + .cursor/mcp.json

Done! Edit brand/concepts/default/brief.md to get started.
```

</details>

<details><summary>stderr</summary>

```
(empty)
```

</details>

### 2. `node bin/keyart.js --cwd <tmp> concept brief patch default {"oneLiner":"Mossling is an indoor-plant care app that tells you what your plant needs today.","audiences":[{"who":"first-time plant owners","need":"confidence they are not about to kill another plant"},{"who":"people who have already killed a fern","context":"returning after a past failure, a little gun-shy"}],"tone":["warm","calm","quietly expert"],"values":["patience","honesty over hype","small consistent wins"],"colorIntent":"soft living greens with a warm paper ground","typeIntent":"friendly humanist sans with a soft editorial serif for headlines","moodImagery":"sunlit windowsills, terracotta, hand-drawn leaf textures — never sterile stock photography","constraints":["must read as trustworthy, not twee","no cartoon mascots"],"surfaces":["mobile app","marketing homepage"]}`

- exit code: 0
- duration: 1045ms

<details><summary>stdout</summary>

```
Patched brief on concept "default" (brief v2).
```

</details>

<details><summary>stderr</summary>

```
(empty)
```

</details>

### 3. `node bin/keyart.js --cwd <tmp> explore --count 3`

- exit code: 0
- duration: 498120ms

<details><summary>stdout</summary>

```
Explore complete! (concept: default)

Directions seeded:
  - windowlight-botanist
  - terracotta-care-ledger
  - quiet-growth-system

To approve a direction:
  keyart approve <directionId>
```

</details>

<details><summary>stderr</summary>

```
(empty)
```

</details>

### 4. `node bin/keyart.js --cwd <tmp> approve quiet-growth-system`

- exit code: 0
- duration: 869ms

<details><summary>stdout</summary>

```
✓ brand/approved/current-direction.json
  ✓ brand/approved/style-tile-prompt.md
  ✓ brand/approved/homepage-mockup-prompt.md
  ✓ brand/approved/homepage-mockup.png
  ✓ brand/approved/style-tile.png
  ✓ brand/brand.yaml (approved pointer → concept "default")
  ✓ brand/generated/asset-pack/quiet-growth-system/ (0 assets)
  ✓ brand/guides/visual-style-guide.md
  ✓ brand/guides/brand-guide.md
  ✓ brand/generated/image-prompts.md
  ✓ brand/generated/implementation-brief.md
  ✓ brand/generated/brand.css
  ✓ brand/guides/style-board.md
  ✓ brand/guides/style-board.svg
  ✓ .cursor/rules/keyart-brand.mdc
  ✓ brand/generated/cursor-brand.mdc
Concept "default" marked approved.

Approved direction "Quiet Growth System" (quiet-growth-system@2026-08-10T04-02-11-308Z).
```

</details>

<details><summary>stderr</summary>

```
(empty)
```

</details>

### 5. `node bin/keyart.js --cwd <tmp> asset pack`

- exit code: 0
- duration: 780ms

<details><summary>stdout</summary>

```
Asset pack written for quiet-growth-system: 0 asset(s), 0 pending.
```

</details>

<details><summary>stderr</summary>

```
(empty)
```

</details>

## Artifact checksums (sha256)

Computed immediately after copying each file from the run's temp project into
`docs/examples/starter-brand/` — proof the committed file is byte-identical to the run's
own output (nothing hand-edited after the fact).

| File | sha256 |
|------|--------|
| `style-tile.png` | `30737602ce8e99520ce060b47c12cb4f3831c3474497f78fbcc79b2717c4b4f3` |
| `homepage-mockup.png` | `960a3c4df7883af2b0a650dea53bba48bf1b52a581e34124ce3b6dfadca6a39c` |
| `palette-type-board.svg` | `97a6c415510ba2e7368806f93b08cf0228ed532cf09a5c507daa0fee793be18d` |
| `palette-type-board.md` | `097d8dd07e9725cb434455679c7d01c782ab17a2a84ba444d212fccfc258812d` |
| `brand.css` | `39d6d8647caf5d9cb01adaf08784aac3b8b21904d33d89a04968a2cfbde96440` |
| `visual-style-guide.md` | `5aa7e8984900fc8f4303a75ce477c6bf342c24e3048000b8e798a54de6f84757` |
| `brand-guide.md` | `0c70511f169b765684b6b37d800bceba6f8a32d6377728332a9d775aadbc7935` |
| `cursor-brand.mdc` | `e74430135ead31c2f0337ca1950472bc9e74aaf3b7162f40794b64aefade1ea6` |
| `tokens.json` | `182a34d5b3d0579a8717bb261eab1647c57c5fa331b0045ba44c7301d1d71832` |
| `contact-sheet.svg` | `65d9d7b7b710d3ba4e8ed7188fb6341f1dcd0182da1a538dd573582251d47aa2` |
| `contact-sheet.md` | `2ef5bf1ec1a14335dde9d797583f34d20a3832a319413e2b67574c9e68c71cfd` |
