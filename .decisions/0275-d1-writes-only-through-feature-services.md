---
id: 0275
title: Every D1 write goes through a feature-service method; reads may sit closer to the edge
status: accepted
date: 2026-08-13
tags: [backend, effect, drizzle, persistence, architecture]
---

# 0275 — Every D1 write goes through a feature-service method; reads may sit closer to the edge

**What this decides:** anything that changes a row in D1 has to happen inside a feature service's own method — never in a route handler, a fate handler, or a helper that hangs off one. Plain reads are allowed to sit closer to the edge, and a route may still hit the database directly to read.

## Context

Founder ruling, recorded on #5472 (2026-08-13): *D1 writes go only through a feature service; reads may be looser.* Two issues had already cited an ADR `0275` by number that never existed, so the rule was being enforced by reference to a missing file. The ruling states the decision is being made now, conversationally, and is recorded here under [0075](0075-issueless-doc-pr-merge-seam.md).

The pieces this rests on already exist and are unchanged by it:

- [0009](0009-d1-direct-defer-dos-and-workflows.md) makes D1 the single store written to directly — this ADR constrains *where* that write may be issued from, not whether it is D1-direct.
- [0010](0010-effect-context-service-backend.md) puts resolver-down backend code behind Effect `Context.Service`s, and [0036](0036-features-as-any-named-app-grouping.md) defines the `features/<name>/` folder those services live in.
- [0016](0016-fate-pure-transport-effect-services-domain.md) already bans database access in the fate transport layer — "fate never touches the database. Every read and write goes through an Effect service method." That covers the fate seam only; it says nothing about an `HttpRouter` route, and its read half is what this ADR loosens.
- [0011](0011-drizzle-context-service.md) / [0014](0014-drizzle-run-batch-as-service-methods.md) define the `Drizzle` service and its `run` / `batch` surface, destructured once at layer build.
- [0041](0041-fate-bridge-worker-managed-runtime.md) resolves the `Database` seam once in the worker's init phase, so routes never rebuild it per request.

What was missing is the rule for everything that is *not* fate: routes added under `/api/*` and `/fate/<feature>/*` can reach `Drizzle` themselves, and nothing said whether that is allowed. It is — for reads. It is not, for writes.

## Decision

**A statement that inserts, updates, or deletes a D1 row runs only inside a method on a feature service; a read may run wherever it is convenient, including directly in a route handler.**

A **feature service**, concretely in this repo: a `Context.Service` declared under `apps/web/worker/features/<feature>/`, whose live layer destructures `orDieAccess(yield* Drizzle)` once at layer build and returns a record of domain-shaped methods (`addDefinition`, `voteOnPost`, `recordSendFailure`) — the shape in [`.patterns/feature-services.md`](../.patterns/feature-services.md). `Sozluk`, `Pano`, `Vote`, `Mute`, `VouchLedger`, `EmailDeliveryLog` are all instances. The test is *where the writing statement's `run` / `batch` call sits*, not which file yielded the accessor: a write inside a `Layer.effect(<Service>)` body is in; the same write in a route body, a fate handler, or a free function called from one is out.

The write half is a hard boundary. The read half is deliberately not one: a route that only needs rows may take `orDieAccess(yield* Drizzle)` and query. The two mecmua routes (`apps/web/worker/features/mecmua/index-route.ts`, `apps/web/worker/features/mecmua/public-read-route.ts`) do exactly that today and stay legal.

**Why the asymmetry.** A write is where invariants live — validation ([0013](0013-validation-in-service-methods.md)), the atomic `batch` that keeps a denormalized aggregate in step with its source row ([0117](0117-stats-write-at-source-mutation-site.md)), the karma/vote coupling, and the `/fate/live` invalidation publish that a fanned mutation owes (CLAUDE.md, [0155](0155-fanned-mutation-publish-guard.md)). A second write path for the same entity means a second place those invariants have to be remembered, and the failure is silent — the row lands, the aggregate drifts, the other clients go stale. A read has no such tail: the worst case is a wrong or slow answer, visible immediately, contained to that handler. Forcing every read through a service buys ceremony (a method, a signature, a test double) for a class of code that carries no invariant.

**Binding constraints.**
- Any `run` / `batch` callback containing `insert` / `update` / `delete` / DDL lives in a feature service's live-layer body.
- Raw SQL is still allowed for a write, via the `run((db) => db.run(sql...))` escape hatch — but at a feature-service call site, never at a route. The alchemy D1 client's own statement surface (`prepare` / `exec` / `batch`) has no consumer in the worker today besides `DatabaseLive` taking `raw`; introducing one to carry a write is banned.
- `apps/web/worker/db/Drizzle.ts` remains the only file that reads the `PHOENIX_DB` binding.

**Banned.**
- A write from a route handler, a fate handler, or a helper invoked by one.
- A per-feature second write path that bypasses the service so it can skip validation, the atomic batch, or the live publish.

## Consequences

**Easier.** One place per entity to look for "what happens when this is written," so the invariant set (validation, aggregate batch, live publish) has exactly one enforcement site. Read code stays cheap — a new read-only route is a handler and a helper, no service surface to grow.

**Harder.** A route that needs one small write has to grow (or reach for) a service method; there is no sanctioned shortcut.

**The obvious guard shape does not work, and this is the useful part to record.** #5473 proposes a fail-closed check that reds on `yield* Drizzle` / `yield* Database` in a non-test file outside `apps/web/worker/db/`. Counted at HEAD, that matcher hits **20 sites**, and it is wrong about nearly all of them:

- **16** are the feature services this ADR exists to permit — `vote/Vote.ts`, `reaction/Reaction.ts`, `mecmua/Mecmua.ts`, `kunye/VouchLedger.ts`, `kunye/RelationStore.ts`, `mute/Mute.ts`, `pasaport/Pasaport.ts`, `pasaport/email-delivery-log.ts`, `search/Search.ts`, `pano/Pano.ts`, `pano/Bookmark.ts`, `report/Report.ts`, `sozluk/Sozluk.ts`, `bildirim/Notification.ts`, `funnel/Funnel.ts`, `stats/Stats.ts`.
- **2** are `Database`-seam wiring, not a query at all: `apps/web/worker/index.ts` resolving the raw handle once in init ([0041](0041-fate-bridge-worker-managed-runtime.md)), and `pasaport/better-auth-live.ts` handing the same handle to the better-auth adapter.
- **2** are the mecmua read routes, which this ADR explicitly allows.

So the accessor-presence matcher reds on 20 legal sites and zero illegal ones. **Presence of the accessor is not the discriminator — the discriminator is a writing statement outside a `Layer.effect(<Service>)` body.** Whoever builds the guard has to key on the write verb *and* its enclosing construct, and should expect the honest fallback to be "this stays a review-held rule" rather than a matcher that trains everyone to ignore it. Fail-closed on zero scope still applies ([0092](0092-gates-fail-closed-on-zero-scope.md)); a guard that cannot tell legal from illegal is not made safe by failing closed.

**Docs.** [`.patterns/alchemy-drizzle-d1.md`](../.patterns/alchemy-drizzle-d1.md) currently says "reach for the statement surface only when a query is genuinely better expressed as raw SQL" with no read/write qualifier, which now reads as permission for a raw write at a handler. Splitting that guidance is #5472's scope — an ADR PR is purely additive, so it is not edited here.

## Records

- Recorded from the founder ruling on #5472. #5472 and #5473 unpark once this file lands; #5473's matcher keeps its own repair scope (see the consequence above).
- **Vocabulary impact:** the ADR redefines **feature service** — until now a code-shape term in [`.patterns/feature-services.md`](../.patterns/feature-services.md) ("one `Context.Service` per feature folder"), it is now also the *write boundary*: the only construct inside which a D1 write may run. The term is absent from [`.glossary/TERMS.md`](../.glossary/TERMS.md); routed there by a filed `report` rather than in this PR, which stays additive.
