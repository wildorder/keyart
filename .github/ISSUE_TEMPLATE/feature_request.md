---
name: Feature request
about: Suggest an idea or improvement
labels: enhancement
---

## The problem

What are you trying to do, and what's stopping you? Describe the problem, not
just the solution you have in mind.

## Who hits this

Is this something every user runs into, or a specific workflow / project
shape? The more concrete, the easier it is to evaluate.

## What you've tried

Any existing commands, flags, or workarounds you've already attempted.

## Does this fit Keyart's v1 constraints?

Please check this against Keyart's hard constraints before writing up a
full proposal — a request that conflicts with these can't land as described:

- **Local filesystem only** — no database, auth, SaaS, billing, or cloud
  sync.
- **OpenAI only** — no multi-provider abstraction.
- **No Figma API/plugin integration** — Figma-friendly local file formats
  (transparent PNG, SVG, DTCG tokens JSON) are in scope; a live Figma
  integration is not.

If your idea runs into one of these, it's still worth raising as a
discussion, but flag that up front so reviewers know what they're looking at.

## Proposed solution

What you'd like to see, if you have something specific in mind.
