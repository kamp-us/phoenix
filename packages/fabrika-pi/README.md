# @kampus/fabrika-pi

Every [fabrika](../../claude-plugins/fabrika/) skill plus all eight agent shells, bundled as one
npm package a [pi](https://github.com/badlogic/pi-mono) project can consume with one command
([ADR 0332](../../.decisions/0332-fabrika-pi-ships-as-npm-package.md)).

## Install

```bash
pi install npm:@kampus/fabrika-pi
```

Pi reads the installed package's manifest keys (`pi.skills`, `pi.subagents.agents`) and discovers
the bundled resources with no further wiring.

**Agent shells require the [pi-subagents](https://github.com/nicobailon/pi-subagents) extension**
(`pi install npm:pi-subagents`) — that is the convention that reads `pi.subagents.agents`. **All
skills work without it**: skills are standard SKILL.md trees, which pi loads natively.

## Single-source rule

Nothing in this package is hand-maintained. Authored content lives only at:

- [`claude-plugins/fabrika/skills/`](../../claude-plugins/fabrika/skills/) — ~25 SKILL.md trees,
- [`agents/`](./agents/) — the 8 agent shells (builder, mixed-builder, operator, reviewer,
  shipper, triager, ui-builder, ui-reviewer); pi-specific authored content, living in-package.

`scripts/sync-bundle.mjs` copies both into `dist/` at build/pack time (`prepack` runs it; so does
`pnpm --filter @kampus/fabrika-pi sync`). The script refuses to bundle zero skills or zero agent
shells, and rebuilds `dist/` from scratch on every run — never edit anything under `dist/`, and
never commit a bundled copy: both are lost or wrong on the next sync.

The package carries **zero dependencies** by design: pi's installer resolves npm dependencies but
does not speak pnpm's `catalog:` protocol (#6970 prototype), so there is nothing to resolve.

## Publishing

Versioned by release-please and published through the documented release path
([`.patterns/release-path.md`](../../.patterns/release-path.md)) — publishing stays human-gated;
no CI publishes this package without that flip.
