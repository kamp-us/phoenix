---
id: 0001
title: No `export default`
status: accepted
date: 2026-05-09
tags: [code-style, typescript]
---

# 0001 — No `export default`

## Context

Default exports are renameable on import, weaken IDE rename / find-references, and force barrels into the awkward `export { default as X } from './X'` form. They also make grep-for-symbol unreliable.

## Decision

No `export default` anywhere in TS / TSX. Named exports only.

## Consequences

- Component modules: `export function Button(...)` — never `export default function Button`.
- Barrels: `export { Button } from './Button'` — never `export { default as Button } from './Button'`.
- Imports: `import { Button } from './Button'` — never `import Button from './Button'`.
- When porting third-party / handoff code, refactor defaults to named as part of the integration.
- `export default class Foo {}` is also banned; use `export class Foo {}`.
- No exception for "single-export" modules — consistency wins.
