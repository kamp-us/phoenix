---
id: 0168
title: "D1 region strategy for the cross-region read floor — adopt Smart Placement first, defer D1 read replication (Sessions API) as an instrumented follow-up"
status: accepted
date: 2026-07-06
tags: [infra, d1, performance, platform]
---

# 0168 — D1 Region Strategy: Smart Placement First, Read Replication Deferred

## Context

The authed pano feed's `/fate` request sits on a **~1.0s steady-state latency floor** for
users far from our D1 primary (measured 2026-07-06 production: 997–1192ms across 40 samples;
anonymous ≈ 300ms). The in-database time is negligible — D1 `queryBatchTimeMs` p50 was 0.2ms —
so the floor is **network**, not query, cost. It is the product of two facts:

- Prod D1 runs its primary in **ENAM** with read replication **disabled**, confirmed from the
  live database's reported `running_in_region: ENAM` and `read_replication.mode: disabled`. Every
  worker isolate far from ENAM pays ~70–80ms per D1 round trip.
- The authed feed issues **~9–11 serial query phases**, so a distant isolate multiplies that
  per-trip cross-region cost into a ~1s wall.

This ADR is the **platform half** of [#2276](https://github.com/kamp-us/phoenix/issues/2276),
split from [#2275](https://github.com/kamp-us/phoenix/issues/2275). #2275 owns the **code lever** —
collapsing the serial phases so fewer round trips are chained; that shrinks the *multiplier* but
leaves the *per-trip cross-region cost* untouched. Closing the remaining floor for distant users is
a **region-strategy** call, which is a recorded decision, not code a `write-code` agent picks up
cold — this ADR records that choice. Ownership is engineering-led platform/infra
([0078](0078-product-driven-decisions-by-default.md)) with a founder-side deploy + cost dimension,
so it routes to the founder as a decision before any topology change.

Two levers were on the table. Both were grounded against Cloudflare's authoritative documentation
per the CLAUDE.md platform-behavior rule; every behavior claim below carries its citation.

### Lever A — D1 read replication via the Sessions API

Cloudflare D1 read replication adds **read-only asynchronously-replicated copies** of the primary
in multiple regions; a read served by a nearby replica avoids the cross-region trip to the ENAM
primary. **All write queries are still forwarded to the primary** — replication only speeds reads.
[[D1 read replication]](https://developers.cloudflare.com/d1/best-practices/read-replication/)

Because replication is asynchronous, a replica "may be arbitrarily out of date" (its *replica lag*),
which without coordination lets a read land on a stale replica. D1 resolves this only when reads go
through the **Sessions API** (`env.DB.withSession(bookmark)`): a session attaches a **bookmark** to
each query and D1 serves it from an instance "at least as up-to-date as the bookmark," yielding
**sequential consistency** across the session — monotonic reads, and read-your-own-writes within
the session. Outside a session, "all queries will continue to be executed only by the primary
database." A session can start `first-unconstrained` (first read may hit any replica, possibly
slightly stale), `first-primary` (first read hits the primary — latest data, one primary round
trip), or from a prior `bookmark` (carried across requests, e.g. in a response header) to chain
consistency.
[[Sessions API + consistency model]](https://developers.cloudflare.com/d1/best-practices/read-replication/#replica-lag-and-consistency-model)
The config change lands at the D1 resource declaration —
[`apps/web/worker/db/resources.ts`](../apps/web/worker/db/resources.ts) (`read_replication.mode: auto`),
**not** `alchemy.run.ts` — plus threading `withSession`/bookmark plumbing through the fate read
loaders.

**Cost:** none extra. "D1 read replication is built into D1, so you don't pay extra storage or
compute costs for read replicas… the exact same D1 usage billing with or without replicas, based on
`rows_read` and `rows_written`."
[[D1 replication pricing]](https://developers.cloudflare.com/d1/best-practices/read-replication/#pricing)

### Lever B — Smart Placement

Smart Placement moves the **worker isolate** near the back-end it talks to most, rather than near
the user: "By placing the Worker near the database, Cloudflare reduces the total request duration,"
achieving "single-digit millisecond latency to databases." With `mode: "smart"`, Cloudflare
"automatically analyzes your Worker's traffic patterns and places it in an optimal location… For
each candidate location, Smart Placement considers the Worker's performance and the network latency
added by forwarding the request. If a candidate location is significantly faster, the request is
forwarded there; otherwise, the Worker runs in the default location closest to the request." It is
therefore **best-effort and adaptive**, and "only considers locations where the Worker has
previously run."
[[Smart Placement]](https://developers.cloudflare.com/workers/configuration/smart-placement/)

Two behaviors make this a clean fit for `apps/web`:

- It **only affects `fetch` event handlers**; and **static assets are always served from the
  location nearest to the incoming request** — so the SPA delivered through our `assets` binding
  stays at the edge for every user regardless of where the isolate runs.
- Since our single meaningful upstream is D1-in-ENAM, smart placement pulls the isolate toward
  ENAM, converting the feed's ~11 **cross-region** D1 trips into ~11 **in-region** trips at the
  cost of a **single** client→isolate hop for distant users.

The config is a **one-block `placement` change** in
[`apps/web/alchemy.run.ts`](../apps/web/alchemy.run.ts) (no `placement` block exists today) and no
code change. It is **available on all Workers plans** with no metered add-on cost.
[[Enable Smart Placement]](https://developers.cloudflare.com/workers/configuration/smart-placement/)
Its consistency profile is the current one **unchanged**: a single ENAM primary, strong
consistency, no bookmarks, no staleness — placement moves *where the isolate runs*, not *how many
copies of the data exist*.

## Decision

**Adopt Smart Placement first; defer D1 read replication (Sessions API) as a documented,
instrumented follow-up.** Neither topology change is made in this ADR — this records the strategy;
the implementation is a separate follow-up scoped in Consequences.

Smart Placement is the recommended first lever because it attacks the exact shape of this floor —
**many serial cross-region D1 trips from one isolate** — with the smallest surface and the cleanest
tradeoff:

- It collapses **all ~11** cross-region D1 trips to in-region for the placed isolate, not just the
  read subset, so it helps the write path too — whereas replication speeds **reads only** and
  leaves every write on a cross-region trip to the ENAM primary.
  [[replication is read-only]](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- It is **one config block and zero application code** in `alchemy.run.ts`, versus replication's
  Sessions-API rewrite of the read path (`withSession` + bookmark propagation through the fate
  loaders) in `resources.ts` and the loaders.
- It **preserves the current strong-consistency model** — one ENAM primary, no replica lag, no
  bookkeeping — which matters because realtime correctness is a core UX tenet
  ([0157](0157-realtime-is-a-core-ux-tenet.md)) and fanned mutations already publish live
  invalidations that assume a single authoritative read-after-write source.
- It **costs nothing extra** (all plans), same as replication.
  [[all plans]](https://developers.cloudflare.com/workers/configuration/smart-placement/)

Start with `mode: "smart"` (adaptive, self-correcting, cannot pin the isolate to a wrong region),
and treat an explicit `region` hint to an ENAM-adjacent cloud region as the deterministic fallback
if smart mode does not converge — a tuning detail for the implementation follow-up, validated via
the `cf-placement` response header and request-duration analytics that the placement docs expose.

Read replication is **deferred, not rejected**: it becomes the right lever once (a) there is a
genuinely globally-distributed **read audience** whose reads a single ENAM-placed isolate cannot
serve locally, and (b) the read path is instrumented to carry bookmarks so `first-primary` /
`bookmark` sessions preserve read-your-own-writes for the live feed. Until both hold, its
consistency-model tradeoff and code surface buy little over placement.

## Alternatives considered

- **Read replication now (Lever A alone).** Rejected as the *first* move: it speeds only reads
  (writes still cross-region to ENAM), and it trades the current strong-consistency model for a
  sequential-consistency model that must be actively managed through Sessions-API bookmarks — a
  real read-path rewrite — for a currently small, non-globally-distributed audience (founders +
  vouch-admitted yazars). The win does not yet justify the complexity, and placement addresses the
  same floor more completely with less surface.
- **Both at once.** The levers are not mutually exclusive and stack cleanly later (an ENAM-placed
  isolate reading from local replicas). Rejected **now** only to avoid taking on the Sessions-API
  consistency surface before a distributed read audience makes it pay; sequencing placement first
  keeps the change reversible and easy to measure in isolation.
- **Neither — keep the floor, rely on #2275 only.** Rejected: #2275's phase-collapse lowers the
  multiplier but cannot remove the per-trip cross-region cost, so a distant authed user keeps a
  multi-hundred-ms floor. A one-line, zero-cost, consistency-neutral placement change that removes
  most of it is worth taking.
- **Explicit `region` pin as the primary choice (instead of `mode: "smart"`).** Deterministic, but
  brittle: it hard-codes a cloud region and forgoes the adaptive re-placement smart mode gives as
  traffic shifts. Kept as the fallback, not the default.

## Consequences

- **Implementation is a separate follow-up, not done here.** A `write-code` change adds the
  `placement` block to [`apps/web/alchemy.run.ts`](../apps/web/alchemy.run.ts) and validates the
  effect on the authed-feed floor via the `cf-placement` header and Cloudflare's request-duration
  analytics before/after. This ADR neither edits `alchemy.run.ts`/`resources.ts` nor flips any
  replication or placement setting.
- **Watch the anonymous / light-request path.** Placement trades a client→isolate hop for saved D1
  trips; requests with few D1 trips (anon feed ≈ 300ms) have less to amortize, so the follow-up
  must confirm placement does not regress them. Smart mode's "only forward if significantly faster"
  behavior softens this, but it is a measured check, not an assumption.
- **`/fate/live` SSE and the LiveDO are a fetch-handler surface too.** Smart Placement affects
  `fetch` handlers, so the live subscribe path can also be re-placed; the DO topology
  ([0037](0037-unified-void-aligned-live-do.md)) is unaffected by the data-location choice but its
  latency profile under placement should be observed in the follow-up.
- **Read replication remains a live, recorded option.** When a distributed read audience appears,
  the deferred lever is adopted by enabling `read_replication.mode: auto` at
  [`apps/web/worker/db/resources.ts`](../apps/web/worker/db/resources.ts) and threading the
  Sessions API through the fate read loaders, stacking on top of placement. This ADR captures the
  grounded reasoning so that future adoption starts from the decision, not from scratch.
- **All platform-behavior claims here are cited to Cloudflare's docs.** Any future revision that
  rests on a different D1 / Sessions-API / Smart-Placement behavior must re-ground against the
  authoritative source, not this summary.

## Vocabulary impact

No new term coined or redefined. This ADR re-decides region/placement mechanics over already-named
concepts (D1, the fate loaders, the worker isolate); the terms it uses — *read replica*,
*bookmark*, *sequential consistency*, *Smart Placement* — are Cloudflare's own, defined in the cited
docs, not phoenix vocabulary. No `.glossary/TERMS.md` change.

## Relationship to prior decisions

- **[#2275](https://github.com/kamp-us/phoenix/issues/2275)** — the code-lever sibling
  (phase-collapse); this ADR is its platform half.
- **ADR [0009](0009-d1-direct-defer-dos-and-workflows.md)** — D1-direct as the canonical store; this
  decision is about *where* that store's reads/writes are served from, not *whether* to use D1.
- **ADR [0057](0057-multi-app-multi-worker-repo.md)** — one worker per app; the `placement` block is
  a per-worker setting on `apps/web`'s stack.
- **ADR [0078](0078-product-driven-decisions-by-default.md)** — platform/infra is engineering-led;
  the deploy + cost dimension routes the call to the founder.
- **ADR [0157](0157-realtime-is-a-core-ux-tenet.md)** — realtime correctness as a UX tenet; a reason
  to prefer placement's unchanged strong-consistency model over replication's managed staleness for
  now.
- **ADR [0037](0037-unified-void-aligned-live-do.md)** — the LiveDO; noted as a fetch-handler surface
  to observe under placement.
