## What changed and why

<!-- Describe the change and the problem it solves. Link an issue if one
exists. -->

## How it was tested

<!-- Manual steps you took, or which existing/new automated tests cover this.
"Ran the gate" belongs in the checklist below, not here — this is about
what specifically exercises the new behavior. -->

## Checklist

- [ ] `npm run build && npx tsc --noEmit && npx vitest run` passes
- [ ] `npm run test:package` passes (if packaging, the build, or `serve`
      changed)
- [ ] Tests added/updated
- [ ] Docs updated (`README.md`, `docs/cli-reference.md`, `docs/mcp.md`,
      or `CHANGELOG.md`, as applicable)
- [ ] No new runtime dependency (or: justified below)
- [ ] No product-behavior change outside what's described above (record
      shape, HTTP routes, MCP facades, CLI/MCP surface all unchanged unless
      that's the point of this PR)

<!-- If you checked "justified below", explain the new dependency here. -->
