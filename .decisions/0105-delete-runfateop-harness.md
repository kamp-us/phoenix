---
id: 0105
title: Delete the zero-consumer `runFateOp` op-test harness
status: accepted
date: 2026-06-21
tags: [fate, testing]
---

# 0105 — Delete the zero-consumer `runFateOp` op-test harness

## Context

`apps/web/worker/features/fate/run-fate-op.ts` (`runFateOp`) is a heavyweight
in-process op-test harness: it builds a per-op `ManagedRuntime` from the caller's
worker layer, drives one fate operation through `FateInterpreter.handleRequest`
over the native serving path (ADR 0043), and records the `live.*` publishes the
operation fanned out via the real `livePublisherFor`. It was written as the test
mirror of `route.ts`'s `handleFate`.

The codebase did not settle its fate on its own, and two grounded sources pointed
opposite ways. This decision resolves the fork (umut chose "delete" in-session),
grounded in the live source:

1. **Zero live consumers.** `grep -rn runFateOp apps/web packages` (excluding
   `node_modules`/`.claude/worktrees`) returns only `runFateOp`'s own definition
   plus one comment in [`resolve-wire.testing.ts`](../apps/web/worker/features/fate/resolve-wire.testing.ts)
   that names it as "the heavyweight `runFateOp` interpreter harness" it
   **deliberately avoids**. `apps/web` already grew a lighter testing seam
   (`resolveWire`) precisely so it would not have to stand up this harness. The
   only `*.test.ts` callers (`app.test.ts` / `products.test.ts`) survive only in
   stale `.claude/worktrees/` snapshots; the live `app.test.ts` is black-box HTTP
   over the worker and never imports it.

2. **The interpreter logic the "keep + re-author" arm would unit-test is already
   unit-tested at the package tier.** `FateInterpreter.handleRequest` lives in
   [`packages/fate-effect/src/Interpreter.ts`](../packages/fate-effect/src/Interpreter.ts)
   and is driven by `packages/fate-effect/src/Executor.test.ts` (over the shared
   sözlük fixture) and `Codegen.test.ts`. No `apps/web` harness is needed to cover
   the dispatch loop.

3. **`.patterns/effect-testing.md`'s retention note is stale doc drift, not a live
   reason to keep.** It described `runFateOp` as an "in-process mirror … no longer
   a test backing" — i.e. a path with no consumers. A doc describing dead code is
   drift to reconcile, not evidence of intentional retention.

4. **The one thing `runFateOp` uniquely did — record per-op `live.*` publish
   fan-out over the real `livePublisherFor` — has no unique coverage gap.** It is
   already covered by the live-publisher unit tests (#1133) plus the integration
   tier. The rejected "keep" rationale would only hold if a *fast unit-tier*
   assertion of per-op live-publish fan-out over a substituted `Database` seam were
   wanted; it is not — the integration tier and the live-publisher units suffice.

## Decision

**Delete `apps/web/worker/features/fate/run-fate-op.ts`** and reconcile every
surviving doc reference so nothing claims a live in-process op-test harness.

**Reachability story for `route.ts → FateInterpreter` (ADR-0082-consistent).**
The native serving path is covered at the integration tier — the ADR-0082
integration core over real D1 (extended by ADR 0104's two-mode tier) — plus the
black-box `app.test.ts` over the worker. The interpreter dispatch loop itself is
covered at the package unit tier (`fate-effect`'s `Executor.test.ts` /
`Codegen.test.ts`). The light app-level resolve/wire seam is `resolveWire`
([`resolve-wire.testing.ts`](../apps/web/worker/features/fate/resolve-wire.testing.ts)),
which proves the per-op class→wire-code translation without a `ManagedRuntime` or
a database. No app-level in-process interpreter harness sits between these tiers,
and none is wanted.

## Consequences

- `run-fate-op.ts` is removed; `apps/web` no longer carries a heavyweight op-test
  harness with no callers.
- The three stale doc references are reconciled: `.patterns/effect-testing.md`
  (the retention note, the resolve/wire contrast, and the `LivePublisher`-capture
  example all stop pointing at the deleted file), `layers.ts`'s doc-comments
  (which named `run-fate-op.ts` as a disposing test harness), and the
  `resolve-wire.testing.ts` comment (which named the harness it avoids).
- Future per-op fate behavior is tested by tier: interpreter dispatch in
  `fate-effect` units, route reachability at the integration tier, per-op
  class→wire-code at the `resolveWire` unit seam. Anyone wanting a fast unit-tier
  assertion of per-op `live.*` fan-out over a substituted `Database` must justify
  it against this decision and the existing live-publisher units before
  reintroducing an in-process interpreter harness.
