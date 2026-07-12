# Serial read baseline — non-pano authed reads (epic #2567, phase 1 / #2707)

The **before** number the stamp-chain collapse (#2709 sözlük, #2710 pano) is judged
against. Measurement only — no read behavior changes here. Grounded in the source call
chain and the 2026-07-06 production investigation's telemetry surface (#2275, ADR 0168).

Two non-pano authed reads finalize through the identical serial chain
`fetch → stampViewerScalars → stampReactionAggregate → stampAuthorIdentity`, each phase a
chained D1 round-trip though the three stamps are mutually independent given the fetched
rows:

- **sözlük definition read** — `Sozluk.ts`: `getDefinitionsByIds` / `listDefinitionsKeyset`
  (the `listDefinitionConnection` view).
- **pano thread/comment read** — `comment-operations.ts`: `getCommentsByIds` /
  `listCommentsKeyset` (the `listCommentsConnection` view).

## Serial D1 phase count (authed / viewer-present path)

Each stamp is already batched (one `IN (…)` read per stamp for the whole page, never a
per-row N+1) — the *phases* are serial, not the per-row reads. `stampReactionAggregate`
(`reaction-aggregate.ts` → `Reaction.readAggregate`) issues **two** D1 reads — a per-target
`GROUP BY count(*)` + the viewer's `readMine`. They are wrapped in one `Effect.all([...])`
**with no `concurrency` option**, so they run **sequentially on the critical path**: the
aggregate is **two serial phases / two round-trips**, not one. `readMine` (`Vote.readMine`)
and `getProfileIdentitiesByIds` (`Pasaport`) are one read each.

The reaction aggregate's `Effect.all` is itself sequential because `concurrency` is never
opted into — a factual property of the current code (`Reaction.ts` `readAggregate`) the
collapse work (#2709/#2710) will address. Grounded in the pinned `effect` `4.0.0-beta.92`
(catalog): `Effect.all` over a tuple is an iterable, so `all` delegates to `forEach`
(`internal/effect.ts` `all` iterable branch, line 4272), whose default is
`concurrency ?? 1` → `1` (line 4514) → `if (concurrency === 1) return forEachSequential(…)`
(lines 4519–4520). Default execution is in-order/sequential; concurrency must be opted into.

| Read | Serial phases (critical path) | D1 round-trips |
|------|------|------|
| `getDefinitionsByIds` / `getCommentsByIds` (by-id) | **5** — fetch → viewer-scalars → reaction-aggregate (2 sequential reads) → author-identity | 5 |
| `listDefinitionsKeyset` / `listCommentsKeyset` (connection, first page) | **6** — totalCount → fetch → viewer-scalars → reaction-aggregate (2 sequential reads) → author-identity | 6 |
| connection read with a cursor (`after` present) | **7** — adds the cursor-resolve read before fetch | 7 |

The **collapsible tail** is the three stamps (viewer-scalars → reaction-aggregate →
author-identity), which are **4 serial phases** (the reaction stamp is two of them) that the
collapse folds into **1 concurrent wave**, so each read path drops **3 serial phases**
(by-id 5 → 2; connection first-page 6 → 3). That 3-phase drop, not any absolute wall-time,
is the placement-invariant number each collapse child proves its win against.

### Realized — sözlük (#2709)

The sözlük definition reads (`getDefinitionsByIds` / `listDefinitionsKeyset`) now route their
three stamps through the shared `parallelStampWave` combinator
([`stamp-wave.ts`](./stamp-wave.ts)), and the reaction stamp's own two reads join the wave via
`Reaction.readAggregate`'s new `concurrency` option — so the **full 4-phase tail collapses to 1
concurrent wave** when the flag is on: **by-id 5 → 2, connection first-page 6 → 3 (the documented
3-phase drop).** With the default-off `phoenix-sozluk-stamp-wave` flag the wave runs at
`concurrency: 1` — the reads stay serial, byte-for-byte today's output. The knob flips wall time
only; the pano sibling (#2710) reuses the same combinator behind its own seam.

### Realized — pano (#2710)

The pano thread/comment reads (`getCommentsByIds` / `listCommentsKeyset`) now route their three
stamps through the same shared `parallelStampWave` combinator ([`stamp-wave.ts`](./stamp-wave.ts)),
and the reaction stamp's own two reads join the wave via `Reaction.readAggregate`'s `concurrency`
option — so the **full 4-phase tail collapses to 1 concurrent wave** when the flag is on: **by-id
5 → 2, connection first-page 6 → 3 (the documented 3-phase drop).** With the default-off
`phoenix-pano-stamp-wave` flag the wave runs at `concurrency: 1` — the reads stay serial,
byte-for-byte today's output. Scoped to the thread read only; the pano feed
(`listPostsConnection`, the #2322 base/overlay split) is untouched — it is the reference pattern,
not a target.

## Wall-time baseline (method + numbers)

**Method** — reuse the 2026-07-06 production investigation's surface (#2275, ADR 0168):
Workers Observability + D1 analytics (`queryBatchTimeMs`) for in-DB time, and the
`cf-placement` response header to confirm worker↔D1 co-location. That investigation
measured, on the authed `/fate` feed:

- in-DB time negligible — `queryBatchTimeMs` p50 **0.2 ms** (the floor is round-trips, not
  query work);
- each serial phase dominated by a **~70–80 ms cross-region D1 round trip**
  (pre-Smart-Placement, worker distant from the ENAM D1 primary);
- the authed pano feed floored at **~1.0 s** built from ~9–11 serial phases.

Applying that measured per-phase cost (serial phases × ~70–80 ms, in-DB negligible) to the
two read paths gives the pre-placement cross-region baseline:

| Read | Serial phases | Baseline wall time (pre-placement, ~70–80 ms/phase) |
|------|------|------|
| sözlük by-id (`getDefinitionsByIds`) | 5 | ~350–400 ms |
| sözlük connection first page (`listDefinitionsKeyset`) | 6 | ~420–480 ms |
| pano by-id (`getCommentsByIds`) | 5 | ~350–400 ms |
| pano connection first page (`listCommentsKeyset`) | 6 | ~420–480 ms |

**Post-Smart-Placement caveat (ADR 0168).** The worker now runs co-located with the ENAM
D1 primary (`index.ts` `placement: {mode: "smart"}`), so each hop is in-region and the
*absolute* per-hop cost drops toward single-digit ms — the absolute wall time is far below
the pre-placement figures above. Smart Placement collapsed the hop *distance*, not the
*sequence*: the serial-phase count is unchanged, and it is what the collapse removes. So the
durable baseline the collapse is measured against is the **serial-phase count** (above); the
wall-time figures are the grounded pre-placement cross-region reference for the same phases.

## Out of scope (named per AC)

- **Session-validation query pair — #2274** (`cookieCache` / auth path). A distinct D1
  concern; the epic's "~11 hops" counts it, but it is not one of these reads' own stamp
  phases and is owned by #2274.
- **Pano feed — #2322** (`listPostsConnection`, the base/overlay `readViewerOverlay`
  split, ADR 0169). Already optimized — the reference pattern, not a target.
