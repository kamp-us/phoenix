---
id: 0002
title: Disable `exactOptionalPropertyTypes` for the SPA tsconfig only
status: accepted
date: 2026-05-09
tags: [typescript, frontend, tsconfig]
---

# 0002 — Disable `exactOptionalPropertyTypes` for the SPA tsconfig only

## Context

Root `tsconfig.json` enables `exactOptionalPropertyTypes: true`. This is correct for the worker side (Effect, Drizzle, request handlers — places where "field omitted" and "field set to undefined" carry different semantics).

In React component prop authoring it produces noise: every optional prop must be re-declared as `prop?: T | undefined` because parents almost always pass `prop={maybeUndefined}` from state. The handoff design system has dozens of `?:` props and threads them through nested components — every one would need the redundant `| undefined`. The rule catches no real bugs in this layer.

## Decision

`apps/web/tsconfig.app.json` overrides with `"exactOptionalPropertyTypes": false`. The worker's tsconfig keeps it on (inherits root). `noUncheckedIndexedAccess` stays on everywhere — it catches real array/index bugs.

## Consequences

- Component authors write `prop?: T` without padding `| undefined`.
- Worker / Effect code still gets the strict semantics where it matters.
- A future ADR can re-enable this if the SPA grows enough domain logic that the tradeoff inverts.
- Any callers passing `undefined` explicitly to optional props compile silently — accepted.
