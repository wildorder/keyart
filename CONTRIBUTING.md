# Contributing to Keyart

Thanks for looking at Keyart's source. This is a small, local-first tool —
contributions are welcome, but please read this file before opening a PR so
your change lands cleanly.

## Setup

```
git clone https://github.com/wildorder/keyart.git
cd keyart
npm ci
```

Use `npm ci`, not `npm install`: this repo commits `package-lock.json`, and
`npm ci` installs exactly what the lockfile pins (reproducible, and what CI
runs) instead of letting npm resolve a possibly-different tree.

Node **>= 22.18.0** is required (`engines.node` in `package.json`).

If you plan to work on `audit` or `surface scan` (both drive a headless
browser via Playwright), also run:

```
npx playwright install chromium
```

Every other command works without it.

## The canonical gate

This is the bar every change must clear, in full, before it is reported done:

```
npm run build && npx tsc --noEmit && npx vitest run
```

A successful file write proves nothing about correctness — run the gate and fix
every error it reports. (ESLint and Prettier are deliberately not configured —
see [Tests](#tests) below.)

On top of the canonical gate, packaging changes are proven by a second,
**networked** gate:

```
npm run test:package
```

`scripts/smoke-package.mjs` packs the tarball, installs it into a temp
project with **production dependencies only**, runs every CLI command against
it, and boots `keyart serve` on a real port — the closest thing to "does
this actually work once a consumer installs it" short of publishing. It is
networked (`npm install` resolves from the registry), so it is **not** part
of `vitest run` — the default suite stays network-free and key-free. CI and
`prepublishOnly` both run it; run it yourself before touching anything under
`src/commands/serve.ts`, `package.json`'s `files`/`scripts`/`dependencies`,
or the build pipeline.

## The two `serve` runtimes

`keyart serve` has two runtimes, and mixing them up wastes an afternoon:

- **`keyart serve` (default)** serves the studio **prebuilt** from
  `dist/ui` — the exact static bundle `npm run build` produces and the exact
  bundle a consumer installing from npm gets.
- **`keyart serve --dev`** runs the Vite dev server against `src/ui`
  directly. It requires a repo clone (it dynamically imports `vite` +
  `@vitejs/plugin-react`, which are devDependencies).

**The consequence that will otherwise cost you an afternoon: a change under
`src/ui/*.tsx` does not appear in the default runtime until `npm run build`
rebuilds the bundle.** While iterating on the studio UI, run `keyart serve
--dev` instead — it picks up `src/ui` changes live, the same way it always
has.

## The build pipeline

`npm run build` runs:

```
npm run clean && vite build && tsc -p tsconfig.build.json
```

`clean` removes `dist/` outright. This matters: `tsc` never deletes stale
output, so without it a source file you delete keeps its compiled artifact in
`dist/` — and ships in the published tarball — indefinitely.
`vite build` compiles `src/ui` into the static studio bundle at `dist/ui/`.
`tsc -p tsconfig.build.json` compiles the TypeScript CLI/library sources into
`dist/`. `tsconfig.build.json` excludes `**/*.test.ts` and
`src/integration/**` from what gets **emitted** — those files don't belong in
a published package. `npm run typecheck` (`tsc --noEmit`) is unaffected by
that exclusion: it still type-checks **everything** through the root
`tsconfig.json`, tests included.

## How larger changes land

Bigger changes are spec-first and phased: agree on the shape before writing
code, then land it in verifiable phases of roughly five files or fewer, each
one passing the canonical gate on its own rather than leaving the tree broken
until the end. For a substantial change, open an issue describing the approach
before opening the PR.

Two conventions worth knowing before you start. **Root cause over symptom:**
prefer the smallest diff that fully solves the underlying problem, not the
smallest diff that makes the symptom disappear — if the proper fix is out of
scope, say so and propose it as a follow-up rather than shipping a band-aid.
**Structural fixes stay in scope:** if state is duplicated or patterns are
inconsistent *inside the files your change already touches*, fix them; don't
expand into unrelated modules without asking first.

## Tests

Unit tests sit beside the source they cover (`*.test.ts`). Network-free,
key-free end-to-end proofs live under `src/integration/` — OpenAI is always
mocked there, and CI never has an API key. ESLint and Prettier are
**deliberately** unconfigured; match the surrounding file's style rather than
reaching for a formatter.

## Release checklist

Releasing is deliberate and tag-driven. The deliberate human act is pushing
the version tag; the publish itself is performed by the `Release` workflow
(`.github/workflows/release.yml`) via **npm trusted publishing** — GitHub's
OIDC token is exchanged directly with npm, so no publish token exists to
leak, and npm attaches build provenance automatically. Only the maintainer
can push tags, and only this repo + that workflow are registered as the
package's trusted publisher on npmjs.com.

1. `npm run build && npx tsc --noEmit && npx vitest run` — green.
2. `npm run test:package` — green.
3. `npm audit --audit-level=high` — clean.
4. `npm pack` and inspect the tarball by hand: entrypoints present
   (`dist/cli.js`, `bin/keyart.js`, `dist/index.js`, `dist/server.js`,
   `dist/ui/index.html`, `templates/**`), no test files, `LICENSE`,
   `NOTICE`, and `README.md` included, size sane.
5. Update `CHANGELOG.md` for the new version and commit it.
6. **`npm version <patch|minor|major>` then `git push --follow-tags` — the
   deliberate act.** `package.json` is the single version source (the CLI
   and MCP server read it at runtime via `src/pkg-version.ts`), so
   `npm version` bumps, commits, and tags in one step, and the pushed tag
   triggers the publish. The workflow refuses a tag that doesn't match
   `package.json`, and `prepublishOnly` (build + full test suite + tarball
   smoke) runs inside it as the last safety net before the publish.
7. Verify: `npm view @wildorder/keyart` shows the new version with a
   provenance attestation, and `npx @wildorder/keyart@X.Y.Z --version`
   answers from a clean directory. Then create the GitHub release from the
   tag.

A manual `npm publish` from a maintainer's machine remains possible as a
fallback (the same `prepublishOnly` gate runs), but the workflow is the
normal path.
