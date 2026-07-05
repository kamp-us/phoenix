---
id: 0153
title: Product-usage telemetry is a single Analytics Engine seam — one Telemetry service, a fixed event-schema convention, sampling-correct reads
status: accepted
date: 2026-07-04
tags: [analytics, telemetry, observability, product-development-framework, cloudflare]
---

# 0153 — Analytics Engine is the product-usage telemetry seam

## Context

phoenix has crash/error observability (Sentry, ADR 0118) and server-side worker
logs, but **no product-usage telemetry** — no way to answer "how much is feature X
being used, and how does that compare to Y." The forcing question was concrete: are
reactions (ungated, karma-free) cannibalising votes (the karma-bearing ranking
signal)? That is unanswerable today. Product-usage measurement is the last missing
piece of the **product-development framework** — the feedback loop you build product
*with* — not a product feature itself.

The founder's constraint: start with a *good pattern*, not scattered ad-hoc
instrumentation. A telemetry seam that lets every feature hand-roll its own event
shape rots into an unqueryable mess.

## Decision

**Product-usage telemetry is a single Cloudflare Analytics Engine (AE) seam**, wired
as one isolate-level Effect service, with a fixed event-schema convention every
instrument obeys.

### The seam (matches the phoenix binding-as-service idiom, ADR 0028)

- **Resource:** `apps/web/worker/features/telemetry/resources.ts` declares
  `Cloudflare.AnalyticsEngine.Dataset("Events", { dataset: "app_events" })` — an
  alchemy resource (ADR 0026–0031, no wrangler.jsonc). No API provisioning; the
  dataset is created on first write.
- **Service:** a `Telemetry` Tag + `TelemetryLive = Layer.effect(...)` wrapping the
  AE write client — an **isolate-level singleton** merged into `makeFateLayer`,
  exactly like `Database`/`DatabaseLive` and `Flagship`/`FlagshipLive`. The binding
  is stable for the isolate's life, so telemetry is never a per-request service.
- **`writeDataPoint` needs the ambient `RuntimeContext`.** It is discharged *inside*
  the service (captured in the layer closure, `provideService`) — the same pattern
  `LiveTopics.publish` uses (`index.ts:198`). So `Telemetry.emit(...)` is
  `Effect<void>` with **no new error or requirement channel at call-sites**.
- **Fail-safe:** telemetry cannot fail the mutation it observes — the error channel
  is discharged inside the layer (the `orDieAccess` / `LivePublisher`-`never`
  boundary). Emitting is fire-and-forget best-effort, never a source of truth.
- **One narrow surface:** `emit(event: TelemetryEvent)` where `TelemetryEvent` is a
  closed discriminated union (make-invalid-states-unrepresentable). The service owns
  the raw `writeDataPoint` mapping internally — **no feature ever constructs a raw
  data point or names Analytics Engine**, exactly as no feature names Drizzle or the
  LiveDO.

### The event-schema convention (the "good pattern", forced by AE's constraints)

AE gives exactly **one index** (the sampling key, ≤96 bytes), up to 20 string
`blobs`, up to 20 numeric `doubles`, all **positional** (`blob1..`, no named schema).
Fields must be written in identical order across every call or columns misalign
silently — so the field→position map lives in **one module** (the `Telemetry`
service). The fixed layout:

| Field | Holds | Convention |
|-------|-------|------------|
| `indexes: [feature]` | the one sampling/grouping key | the **feature-key** (`vote`, `reaction`, …) — the dimension we compare on, so per-feature counts stay exact |
| `blobs: [feature, action, surface, userId?]` | string dimensions | fixed positional order, defined once in the service |
| `doubles: [1]` | the count (or a measured quantity) | |

- **Index = feature-key** (not userId): you get one exact-under-sampling dimension;
  make it the axis you compare.
- **userId is a blob, deliberately approximate.** It enables rough per-user slicing,
  but distinct-user counts are *estimates* under sampling — never treated as exact.
  Precise per-user behaviour (funnels, retention, exact uniques) is explicitly a
  **future PostHog seam alongside AE, not a reason to reshape this one.**
- Event vocabulary is English/technical (glossary rule — telemetry is not
  product-facing copy).

### Reads are sampling-correct by contract

Reads go through the external AE SQL API (Account Analytics Read token), **never from
the Worker** — an in-app dashboard proxies through an authenticated backend route,
never exposing the token client-side.

**Every query weights by `SUM(_sample_interval)`, never `count()`** — even though at
phoenix's invite-only volume sampling almost never fires (`_sample_interval` = 1, so
the weighted sum equals the raw count). Writing `count()` bakes in a bug that only
surfaces once volume grows and sampling kicks in. The canonical query:

```sql
SELECT toStartOfDay(timestamp) AS day,
       sumIf(_sample_interval, index1 = 'vote')     AS votes,
       sumIf(_sample_interval, index1 = 'reaction') AS reactions
FROM app_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day
```

### First instrument (reference implementation)

`Vote.cast` emits `{feature: vote, action, surface, targetKind}`; `Reaction.*` emits
`{feature: reaction, action, surface, emoji}`. Both are isolate-level services in
`makeFateLayer`, so wiring `Telemetry` in is one `Layer.provide` at the composition
root — no per-request plumbing.

## Alternatives weighed

- **PostHog / a SaaS product-analytics tool** — richer (funnels, retention, exact
  per-user), but a bigger lift (SPA script, consent surface) and answers more than
  the question we have. Chosen as a *future complement* for behavioural depth, not
  the starting seam. AE answers "how much" natively and cheaply with no new SaaS.
- **Per-domain datasets** — rejected; the index + blobs already partition one
  `app_events` dataset, and multiple datasets just fragment queries. Split later only
  if a domain needs different retention/schema.
- **Scattered `writeDataPoint` calls per feature** — rejected; the whole point is one
  service owning the positional schema, so instruments stay consistent day one.

## Consequences

- **Retention is 3 months.** Anything needing longer history rolls up into D1 before
  it ages out.
- **AE ceiling is "how much", not "who / how many distinct / do they return".** Exact
  uniques, funnels, and retention are out of scope by design → the PostHog complement
  when that need is real.
- **Build-time verification (CLAUDE.md grounding mandate):** confirm phoenix's *pinned*
  alchemy version actually exports `Cloudflare.AnalyticsEngine.*` (the seam is
  grounded in the read-only fork snapshot); if not, fall back to a raw
  `host.bind(name, { bindings: [{ type: "analytics_engine", name, dataset }] })` —
  identical wire contract. Ground the Effect layer idiom in effect-smol `LLMS.md`.
- The pattern is canonised as `.patterns/telemetry.md` (via `/canon`, from the
  reference impl + its tests) so every future instrument grounds in it.
