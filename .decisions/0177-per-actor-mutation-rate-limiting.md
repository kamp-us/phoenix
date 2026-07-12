---
id: 0177
title: Per-actor mutation rate limiting at the fate seam, token bucket over a swappable store
status: accepted
date: 2026-07-11
tags: [security, fate, throttle, abuse, durable-objects]
---

# 0177 — Per-actor mutation rate limiting at the fate seam

## Context

The worker had **no per-time / per-actor write throttle anywhere** (#2561). Authenticated
writes — content, votes, reactions, reports — are per-item-bounded (one vote per post, one
reaction per target) but carry **no bound on write *volume***. The onboarding rite sandboxes
a newcomer's *reach* (the çaylak containment), not their *write cadence*, so sandbox floods,
report spam, and reaction churn are unthrottled. Cloudflare's platform request limiting sits
*beneath* the app and cannot distinguish one authenticated writer's volume from another's.

An external security audit ranked a per-actor mutation limiter the single highest-leverage
defense-in-depth control to land **before opening registration to real users**. Today's
cohort is founders-only and vouch-gated, so there is no active exploit — hence p2 — but the
primitive must exist and be wired before that arc becomes active.

## Decision

Add a **per-actor mutation-volume throttle** as a cross-cutting primitive, wired **once** at
the fate composition root (`apps/web/worker/features/fate/layers.ts`) over the merged
mutations record, so it bounds **every** feature's mutation path without touching a single
feature.

Three seams, each doing one job:

1. **`TokenBucket`** (`features/throttle/TokenBucket.ts`) — the algorithm as a **pure domain
   object**: state + policy + the two transitions (refill-by-elapsed-time, try-consume). No
   clock, no store, no Effect; `nowMs` is passed in. This is what keeps the higher layers thin
   and makes the algorithm exhaustively unit-testable, independent of where its state lives.

2. **`RateLimiter`** (`features/throttle/RateLimiter.ts`) — the isolate-level service. It owns
   the actor→budget-key mapping (`CurrentActor`, ADR 0107) and the policy, and delegates the
   state's storage + RMW atomicity to a `RateLimitStore` port. `check(actor)` spends one token
   and fails with `RateLimitExceeded` on empty. Anonymous actors carry no key and pass through
   (their writes are refused by each mutation's own auth gate).

3. **`RateLimitStore`** (`features/throttle/RateLimitStore.ts`) — the **dependency-inverted
   backing-store port**, discharged at the composition root exactly like Vote's `KarmaBump` /
   `VoterStanding` seams. This is the storage swap point.

The wire denial is a dedicated fate wire error, `throttle/RateLimitExceeded` →
`RATE_LIMIT_EXCEEDED` (`features/throttle/errors.ts`), following the `VOUCH_LIMIT_REACHED`
precedent — a throttled write is a clear, distinguishable denial, never a generic 500.

### The storage fork — in-isolate for v1, Durable Object as the named upgrade

The audit framed the choice as **Durable Object vs D1**. Grounded in the existing patterns
(ADR 0037's `LiveDO`; `.patterns/feature-services.md`'s Drizzle/D1 seam), the fork resolves to
a **third option for v1 behind the same port**:

- **D1 — rejected for v1.** A token bucket is a hot read-modify-write on *every* mutation.
  Routing that through D1 doubles the write load on the primary content DB and needs careful
  atomic SQL to avoid an interleaved RMW letting two writes spend the last token. Coupling the
  throttle's availability to the primary DB is the wrong trade for a defense-in-depth control.

- **Durable Object — deferred, not dismissed.** A per-actor DO (`idFromName(actorId)`) is the
  idiomatic Cloudflare *global* rate limiter: its single-threaded execution gives the exact
  per-key RMW atomicity the port demands, across all isolates. But it costs a new DO binding in
  `alchemy.run.ts`, a DO class, and a storage round-trip (latency) on every mutation — real
  infra for a control whose v1 job is defense-in-depth under a founders-only vouch-gated cohort,
  and not exercisable in the unit tier.

- **In-isolate `Map` — chosen for v1.** A per-isolate `Map`, built once per isolate via the fate
  runtime's memoMap; JS's single-threaded event loop makes the RMW atomic per key with no lock.
  Zero new infra, no per-mutation network/DB round-trip, fully unit-testable. Because a single
  flooding actor's burst lands on one (or few) reused isolates, a per-isolate bucket already
  bounds the exact abuse named (sandbox floods, report spam, reaction churn).

  Its one limit is honest and recorded: the bound is **per-isolate, not global**. That is the
  explicit **v1→v1.1 upgrade trigger** — swap `InIsolateRateLimitStoreLive` for a DO-backed store
  behind the same `RateLimitStore` port at the composition root, **without touching
  `RateLimiter` or any feature**, when registration opens (the issue's own sequencing).

### Limit values

One default class covers every mutation: **60 tokens of burst, refilling 1/s** (≈60
writes/minute sustained). Chosen well clear of a human's real write cadence yet tight enough to
bound a scripted flood. A single aggregate per-actor bucket (not per-mutation-class sub-buckets)
is the v1 shape: floods, report spam, and reaction churn all draw from the same actor budget, so
one bucket bounds the aggregate volume the audit cares about. Per-mutation-class values would
slot in as a `Record<class, TokenBucketPolicy>` keyed off the mutation wire name if a class ever
needs a distinct rate; v1 does not.

## Consequences

- Every mutation is throttled per actor at one seam; adding a feature inherits the throttle for
  free (no per-feature wiring).
- `RATE_LIMIT_EXCEEDED` is injected at the composition seam, not through any declared error
  union, so `declaredWireCodes(fateConfig)` does not see it. The SPA-coverage guard
  (`fate/wireCodes.unit.test.ts`) unions `THROTTLE_WIRE_CODES` onto the declared set, so the SPA
  `FATE_WIRE_CODES` list must still cover it — the wire contract stays bound, not hoped.
- The v1 bound is per-isolate. This is deliberate and sufficient for the current cohort; the DO
  upgrade is a one-Layer swap when a registration-opening milestone becomes active (pull #2561 to
  p1 then, per triage).
- Only the *serving* path is throttled; the build-time codegen path (`schema.ts`) consumes the
  plain `fateConfig`, so codegen is untouched.
