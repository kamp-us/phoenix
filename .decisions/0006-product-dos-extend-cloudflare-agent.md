---
id: 0006
title: Product DOs extend Cloudflare's Agent base class
status: superseded
superseded_by: 0009
superseded_date: 2026-05-16
date: 2026-05-09
tags: [architecture, durable-objects, agents-sdk, sozluk, pano]
---

# 0006 — Product DOs extend Cloudflare's Agent base class

> **Superseded (2026-05-16):** Product DOs are retired by [ADR 0009](0009-d1-direct-defer-dos-and-workflows.md). No `Agent`-based product DOs survive in the codebase. When a single, scoped DO is reintroduced later (e.g. WebSocket fan-out), it can re-adopt the `Agent` base under a fresh ADR.

## Context

[ADR 0005](0005-product-dos-shard-by-coordination-atom.md) committed product
DOs (`SozlukTerm`, `PanoPost`) to shard by coordination atom and to be backed
by a D1 view layer maintained by event-driven projection. Two follow-up gaps
remained:

1. The DO base class for product entities — vanilla `DurableObject` requires
   us to hand-roll typed state, WebSocket lifecycle, multiple named schedules,
   and a clean RPC surface. Each is a few hundred lines per DO.
2. The projection layer needs an emission point on every state-changing
   mutation. Calling `enqueue(...)` from every mutation method is fragile —
   easy to add a new mutation and forget to emit.

Cloudflare's Agents SDK ([docs][docs], [repo][repo], part of Project Think
preview, April 2026) ships an `Agent<Env, State>` base class that solves
exactly these gaps. The "agent" framing is misleading — the base class is a
generic stateful-entity primitive. AI integrations are in optional packages
(`@cloudflare/ai-chat`, `@cloudflare/think`) that we do not adopt.

[docs]: https://developers.cloudflare.com/agents/
[repo]: https://github.com/cloudflare/agents

## Decision

Product DOs extend `Agent<Env, State>` instead of `DurableObject<Env>`.

In scope:
- `SozlukTerm` (one DO per term, addressed by `idFromName(slug)`) — as
  refactored under ADR 0005.
- `PanoPost` (one DO per post, addressed by `idFromName(postId)`) — as
  refactored under ADR 0005.
- Future product DOs added later default to extending `Agent`.

Out of scope:
- **Pasaport stays as `extends DurableObject`** per [ADR 0003](0003-pasaport-singleton-do.md).
  Better Auth's drizzle adapter is indifferent to the base class, and Pasaport
  has no use for state sync, WebSocket lifecycle, or AI primitives. Adopting
  Agent for Pasaport would be churn for no benefit.
- The projection mechanism (Queue vs Workflows for D1 fan-out, dual-write vs
  event-sourced) is **deferred to ADR 0007**. This ADR locks the base class
  and the emission chokepoint; ADR 0007 picks the transport.

## Primitives we adopt

From the Agent base class:

- **`this.state: State`** + **`setState(s: Partial<State>)`** + **`initialState`** —
  typed persistent state, automatic JSON marshaling, no manual
  `ctx.storage.get/put` plumbing.
- **`onStateChanged(state, source)`** — the **single chokepoint where
  projection events are emitted**. Every mutation that ends with `setState`
  fires this hook, so projection emission cannot be forgotten when adding
  new mutations. (See "Projection emission contract" below.)
- **WebSocket lifecycle:** `onConnect`, `onMessage`, `onClose`, `onError`,
  `broadcast()` — frontend opens a WebSocket to the per-entity DO; live
  updates to vote counts and definition lists arrive without polling. `setState`
  pushes to all connected clients automatically.
- **`@callable()`** — typed RPC methods. Replaces the existing pattern of
  declaring `async vote(...)` and calling `stub.vote(...)` from resolvers
  with a typed client stub.
- **Multiple named schedules:** `schedule()`, `scheduleEvery()`,
  `getScheduleById()`, `listSchedules()` — replaces the single-`setAlarm`
  limitation. Outbox drain, hot-score recompute, and processed-events cleanup
  can each be their own named recurring task.
- **`this.sql`** — tagged-template SQLite helper. Coexists with
  `drizzle-orm/durable-sqlite` because both go through `ctx.storage` underneath.
  Drizzle remains the primary query builder; `this.sql` is available for ad-hoc
  queries.

We **do not adopt**: `@cloudflare/ai-chat`, `@cloudflare/think`,
`@cloudflare/agent-memory`, or any AI-specific package. The base `Agent` class
is sufficient.

## Projection emission contract

`onStateChanged(state, source)` is the **only** place product DOs emit
projection events. Pattern (illustrated for `SozlukTerm`):

```ts
class SozlukTerm extends Agent<Env, TermState> {
  initialState: TermState = {
    slug: '', title: '', definitionCount: 0, totalScore: 0,
    lastActivityAt: 0, lastEventId: '',
  };

  @callable()
  async vote(definitionId: string, value: 1 | -1, voterId: string) {
    // mutate sqlite atomically (drizzle transaction)
    // recompute denormalized aggregates
    this.setState({
      definitionCount: newCount,
      totalScore: newTotalScore,
      lastActivityAt: Date.now(),
      lastEventId: id('evt'),  // forge monotonic ULID
    });
  }

  async onStateChanged(state: TermState, source: 'server' | Connection) {
    if (source === 'server') {
      await this.emitProjection({
        kind: 'TermChanged',
        slug: state.slug,
        title: state.title,
        definitionCount: state.definitionCount,
        totalScore: state.totalScore,
        lastActivityAt: state.lastActivityAt,
        eventId: state.lastEventId,
      });
    }
  }

  private async emitProjection(event: ProjectionEvent) {
    // Implementation deferred to ADR 0007 (Queue vs Workflows).
    // Whatever the transport, emission is gated on this single hook.
  }
}
```

Rules:
- All mutation methods MUST end with `setState({...})`. Direct sqlite writes
  without a corresponding `setState` are banned — they bypass projection.
- `lastEventId` MUST be set on every `setState` that should produce a
  projection event. Use `forge.id('evt')` for monotonic ULIDs.
- `onStateChanged` MUST guard `source === 'server'` to avoid re-emitting on
  client-initiated state syncs (the framework round-trips state through the
  same hook for client-driven updates).
- The full projection transport (outbox, queue/workflow, consumer, D1 schema)
  is ADR 0007's concern. This ADR commits only to the chokepoint.

## Consequences

### Refactor scope (existing code)

- `apps/web/worker/features/sozluk/Sozluk.ts` — already needs the singleton →
  per-term refactor under ADR 0005. The class becomes `SozlukTerm extends
  Agent<Env, TermState>`. Methods (`listTerms`, `getTerm`, plus future
  mutations) restructured around `setState` + `@callable()`.
- `apps/web/worker/features/pano/Pano.ts` — same: `PanoPost extends
  Agent<Env, PostState>`.
- Both refactors land together with the ADR 0005 sharding refactor — single
  PR per product, not staggered.

### GraphQL resolver shape

Per-entity reads still RPC into the DO via the resolver runtime. The
`@callable()` decorator gives us a typed client stub, but resolvers continue
to use `env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug))` and call
methods directly — Effect resolver pattern unchanged.

### Frontend implications

- **Per-entity pages** (term page, post detail) gain the option of a
  WebSocket subscription to the per-entity Agent for live state. Implementation
  deferred — Relay's `@live` directive or a thin Agent-client subscription
  layer; pick when the first live-update UX lands. Initial reads stay
  GraphQL → DO RPC.
- **Cross-entity pages** (home, feed) keep reading from D1 view store via
  GraphQL; live updates to those lists are not in scope for ADR 0006.

### Risks

- **Preview API.** Agents SDK is part of Project Think preview as of
  2026-04. API may evolve. Mitigation: pin the `agents` package version in
  the catalog; review breaking changes on each upgrade; the surface we depend
  on (`state`, `setState`, `onStateChanged`, `@callable`, `schedule*`) is
  the most stable subset.
- **Drizzle interop unverified.** Both `this.sql` and `drizzle-orm/durable-sqlite`
  go through `ctx.storage` underneath, but no production codebase verified
  the combination as of writing. Validate as part of the Sozluk/Pano refactor;
  if drizzle breaks, fall back to `this.sql` raw queries (acceptable for
  per-entity DOs where the schema is small).
- **Coupling to a Cloudflare-specific abstraction.** Migrating off CF later
  would require unwinding the Agent base class. We accept this — phoenix is
  Cloudflare-native by design (single Worker, DO-everywhere).

### Banned

- New product DOs that `extends DurableObject` directly. Use `Agent`.
- Mutation methods that write to sqlite without ending in `setState({...})`.
  These bypass `onStateChanged` and silently break projection.
- Adopting any of `@cloudflare/ai-chat`, `@cloudflare/think`, or
  `@cloudflare/agent-memory` without a separate ADR justifying the AI usage.

### When superseded

- If Agents SDK is deprecated by Cloudflare or the API breaks beyond what
  pinning solves, write a follow-up ADR documenting the migration target
  (likely `@cloudflare/actors` or vanilla DO with our own primitives).
- If the projection chokepoint pattern proves wrong (e.g., we want to emit
  projection events without a corresponding `setState`), revise — but do
  not silently bypass the contract.
