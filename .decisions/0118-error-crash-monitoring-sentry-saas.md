---
id: 0118
title: Error/crash monitoring is Sentry's free SaaS tier (worker + SPA + Effect), with GlitchTip as the same-protocol self-host escape hatch
status: accepted
date: 2026-06-28
tags: [infrastructure, observability, error-monitoring]
---

# 0118 — Error/crash monitoring is Sentry free SaaS, GlitchTip the escape hatch

## Context

Issue [#1221](https://github.com/kamp-us/phoenix/issues/1221) is the forcing decision: phoenix
(`apps/web` — one Cloudflare Worker on workerd via alchemy, serving a React 19 SPA from the `assets`
binding plus the API) has **no crash/error monitoring that sees the browser**. Production errors on the
client tier — uncaught exceptions, failed renders, error-boundary catches, unhandled rejections —
**happen in the browser and never reach the worker**, with no grouping, no alerting, no visibility into
the crashes users actually hit. The SPA's `Screen.tsx` error boundary currently `console.error`s and
**discards** those failures; they leave no trace anywhere we can see.

CF-native Workers Observability (Workers Logs + source maps) shipped separately as
[#1222](https://github.com/kamp-us/phoenix/issues/1222) and is the **worker-side** baseline. But it is
structurally **server-side only**: it cannot capture browser/SPA errors at all. So no worker-side
telemetry can ever monitor half the app — which **rules out a Cloudflare-native-only answer** and points
at a dedicated tracker (SaaS or self-hosted) that also instruments the browser. This is the decisive gap
#1221 exists to fill.

Per [ADR 0078](0078-product-driven-decisions-by-default.md) this is platform/infra → **engineering-led**;
the type is `decision` regardless. Cost is **near-zero whichever way it goes** (a free SaaS tier, or a
~512 MB self-hosted GlitchTip), so the real axis is **data-ownership / SDK-lock-in / ops-effort**, not
price.

Options evaluated (verified June 2026 against authoritative sources):

- **Sentry SaaS.** Free **Developer** tier = 5K errors/mo, 1 seat, 30-day retention; **Team** $26/mo if
  outgrown. Official `@sentry/cloudflare` (workerd-compatible, needs `nodejs_compat`) + `@sentry/react`,
  plus **`@sentry/effect`** which provides native Effect `Tracer`/`Logger` layers — a genuine fit for
  phoenix's isolate-level-layer model ([ADR 0029](0029-worker-runtime-servicemap.md)). `@sentry/effect`
  is **past alpha** (latest `10.62.0`).
- **Sentry self-host.** Same SDKs, but **heavy** — ~20+ containers (Kafka/ClickHouse/Snuba/Relay/…),
  16–32 GB RAM, single-node, FSL-1.1 license, community support only. Sentry's own docs steer small teams
  to SaaS. **Not worth self-hosting at this scale.**
- **GlitchTip.** **MIT**, a true **Sentry-protocol drop-in** — the *same* `@sentry/*` SDKs, swap only the
  DSN. Hosted free = 1K events/mo; self-host = Postgres + 1–2 containers, ~256–512 MB RAM. The cleanest
  self-host fit and the natural escape hatch if data-ownership becomes a requirement.
- **Bugsink** (Sentry-protocol drop-in, single SQLite container, Polyform Shield, no hosted free tier) and
  the **non-Sentry-protocol** trackers — **Highlight.io** (session replay + errors, own SDK) and
  **Grafana Faro** (OTel/RUM-shaped, no first-class Worker SDK, not issue-grouped) — were considered.
  Adopting Highlight or Faro is a **commitment to their SDK**, not a reversible DSN swap.

The key leverage: **all the Sentry-protocol options (Sentry SaaS, GlitchTip, Bugsink) share one SDK**, so
the SDK wiring is identical and the choice among them is **reversible by swapping a DSN** — the lock-in is
to the *protocol*, not to a *vendor*. That is what collapses this to a single low-regret question.

## Decision

**Adopt Sentry's free SaaS tier for error/crash monitoring**, wired across both tiers via the official
Sentry SDKs:

- **Worker** — `@sentry/cloudflare` (directly; `nodejs_compat` is already on).
- **SPA** — `@sentry/react`, replacing the current discard-on-`console.error` behavior at the
  `Screen.tsx` error boundary so browser crashes are captured and grouped.
- **Effect** — `@sentry/effect` as an **isolate-level `Tracer`/`Logger` layer**
  ([ADR 0029](0029-worker-runtime-servicemap.md)), capturing typed failures **and `Cause` defects**, not
  only thrown exceptions.

**GlitchTip (MIT, Sentry-protocol drop-in) is the named self-host escape hatch** — if data-ownership ever
becomes a requirement, the move is a **DSN swap, with no re-instrumentation**, because GlitchTip speaks
the identical SDK protocol.

**CF-native Workers Observability ([#1222](https://github.com/kamp-us/phoenix/issues/1222)) remains the
worker-side baseline UNDERNEATH** — this is **additive, not a replacement**. Sentry fills the gap #1222
structurally cannot reach (browser/SPA errors); the worker keeps its CF-native logs + source maps as well.

Why this option:

- It is the only family that **covers both tiers** (worker + browser) — the decisive requirement #1221
  was filed against.
- `@sentry/effect` is a native fit for the isolate-level-layer model and is **past alpha** (`10.62.0`), so
  the Effect integration is no longer a pre-stable bet.
- It is **low-regret**: Sentry SaaS and GlitchTip share one protocol + SDK, so vendor lock-in is to the
  *protocol*, not the vendor — the escape hatch costs a DSN, not a rewrite.
- **No infra change**: `nodejs_compat` is already enabled; nothing in the runtime shape moves to adopt it.
- **Cost is near-zero** at phoenix's volume (free 5K-errors/mo tier).

### Decided defaults (the chosen config; each is adjustable at implementation time)

- **Data region: EU.** (Adjustable.)
- **Scrub user PII via `beforeSend` by default** — strip identifying fields before events leave the
  client/worker. (Adjustable.)
- **Start on the free Developer tier** (5K errors/mo, 1 seat, 30-day retention); revisit the Team tier
  only if volume outgrows it. (Adjustable.)
- **Alert routing: TBD at implementation time.** (Adjustable.)

### Scope

This ADR **records the decision only** — the substrate (Sentry SaaS), the both-tiers SDK shape
(`@sentry/cloudflare` + `@sentry/react` + the `@sentry/effect` layer), the GlitchTip escape hatch, and the
decided defaults. **The actual SDK wiring is a separate implementation follow-up** and is explicitly **not**
done here.

## Consequences

- **The browser tier becomes visible.** SPA crashes that today `console.error` and vanish at the
  `Screen.tsx` boundary will be captured, grouped, and alertable — closing the gap CF-native
  observability ([#1222](https://github.com/kamp-us/phoenix/issues/1222)) structurally cannot reach.
- **Two worker-side signals coexist by design.** CF-native Workers Observability stays the worker baseline;
  Sentry adds cross-tier grouping/alerting on top. The worker is double-covered on purpose
  (additive, not a swap).
- **Implementation is a downstream follow-up feature, not part of this decision.** Wiring the SDKs across
  `apps/web/worker/` and `apps/web/src/`, authoring the `@sentry/effect` isolate-level layer, the
  `beforeSend` PII scrub, the DSN/secret binding in `apps/web/alchemy.run.ts` (there is no
  `wrangler.jsonc` — [ADR 0057](0057-multi-app-multi-worker-repo.md)), and the `catalog:` entries in
  `pnpm-workspace.yaml` (every dep is catalog-sourced — CLAUDE.md) all land as a separate write-code
  feature that becomes pickable **after** this ADR merges.
- **Lock-in is bounded to the protocol.** Because GlitchTip is a same-SDK drop-in, a later data-ownership
  requirement is satisfied by a DSN swap, not a re-instrumentation — the escape hatch is real and cheap.
- **Known caveats to carry into implementation:** workerd reports `0ms` span durations (performance
  tracing is weak on the worker — error capture is unaffected); use `@sentry/cloudflare` **directly** to
  avoid a framework-SDK Node-resolution bundling trap
  ([getsentry/sentry-javascript#20038](https://github.com/getsentry/sentry-javascript/issues/20038)); and
  pin the Sentry SDK versions via `catalog:`.
- **Banned (once adopted):** discarding browser errors at an error boundary without reporting them;
  adopting a second, non-Sentry-protocol tracker for the same job (which would forfeit the reversible-DSN
  property); and treating CF-native observability as a substitute for the browser-tier capture this ADR
  establishes.

## Amendment (2026-07-02, [#1502](https://github.com/kamp-us/phoenix/issues/1502)) — data region is US, not the EU default

The decision above named **EU** as the data region, explicitly as a default "adjustable at implementation
time." At implementation it was set to **US**. Recording the realized choice here (not a new ADR) because
this is that flagged knob being turned, not a new decision.

**Why US.** The data region is an **org-wide** Sentry setting, not per-project — every project under an org
inherits its region. The only existing org, `kampus-av`, is US-region. Honoring the EU default would mean
standing up and operating a **second, EU-region org** for a single project — disproportionate to the benefit
for a low-volume error tracker.

**Risk accepted + mitigation.** Error events are stored in the US, so user data could leave the EU. This is
bounded by the **`beforeSend` PII scrub** (the ADR's other decided default), applied on **both** tiers
(`apps/web/src/lib/sentry.ts` and `apps/web/worker/lib/sentry.ts`): the `user` block and request
cookies/headers are stripped **before** any event leaves the client/worker. So what lands in the US is
**scrubbed** error data — a low-regret trade for a free-tier tracker.

**Escape hatch intact.** The reversible-DSN property is unaffected: if data residency ever becomes a hard
requirement, the move is a **DSN swap** to an EU-region Sentry org or a self-hosted EU GlitchTip — no
re-instrumentation. The choice stays as adjustable as the ADR said it was.

**Where realized.** Project `kampus-av/phoenix`; the public DSN is the `VITE_SENTRY_DSN` repo variable, wired
into the prod build (SPA) and prod deploy (worker `SENTRY_DSN` binding) production-only in
`.github/workflows/deploy.yml` ([#1656](https://github.com/kamp-us/phoenix/pull/1656)); worker capture is
deploy-verified in [#1671](https://github.com/kamp-us/phoenix/pull/1671).
