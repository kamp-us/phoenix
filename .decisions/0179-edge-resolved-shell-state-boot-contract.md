---
id: 0179
title: "Edge-resolved shell state — the `window.__BOOT__` contract: the worker renders the shell fresh per request (`[\"/*\", \"!/assets/*\"]` + `ASSETS.fetch` + streaming HTMLRewriter), injecting a shell-key manifest (3 nav flags under full-session userId context + `signedIn`) so the initial paint is already correct — zero CLS, no boot→fetch waterfall; geometry-based above-the-fold line, per-request non-cached FULL render (accepts the ~70–80ms ENAM hop for cohesiveness), unified `useFlag` + fail-closed shell-key manifest, never-hang fallback to the untransformed asset; amends 0168's assets-never-route premise, leaves 0169/0170 intact"
status: accepted
date: 2026-07-12
tags: [platform, performance, frontend, flags, session]
---

# 0179 — Edge-resolved shell state — the `window.__BOOT__` contract

This is a conversation-authored ADR (ADR [0075](0075-issueless-doc-pr-merge-seam.md)): it records
founder rulings charted interactively on the graduated wayfinder map
[#2829](https://github.com/kamp-us/phoenix/issues/2829), synthesized in
[#2836](https://github.com/kamp-us/phoenix/issues/2836). It is the law the build epic
[#2926](https://github.com/kamp-us/phoenix/issues/2926) implements against.

## Context

The shell — the geometry above the fold: nav items (sözlük / pano / mecmua), the topbar
structure, and the signed-in cluster (giriş-yap ↔ user chips) — resolves **client-side, after JS
boot**. The topnav (`apps/web/src/App.tsx`) hardcodes sözlük/pano and spreads `mecmua` in only once
`useFlag(MECMUA_PUBLIC_READ, false)` resolves; `session.isPending`, `MECMUA_FEED`, and
`PHOENIX_NAV_IA` are sibling pop-ins of the same shape. The result is an
HTML → JS-boot → flag-fetch → repaint waterfall with guaranteed layout shift (CLS). The triggering
symptom was #2828 (the topnav `mecmua` link popping in after boot).

`useFlag` (`apps/web/src/flags/useFlag.ts`) is **deliberately non-suspending**: it returns
`{value: default, loading: true}` on first render, POSTs `/api/flags/evaluate`, and setStates after —
its safe-default-on-outage contract is load-bearing, so a plain `<Suspense>` wrapper is a no-op. The
stack is React 19 + Vite SPA with **no SSR**; the same worker serves the API and evaluates flags
server-side (Flagship binding, ADR [0081](0081-feature-flag-substrate-cloudflare-flagship.md)).

The structural fact that shapes every option: the SPA HTML is served **edge-direct by the `assets`
binding — worker code never touches it today.** Only `runWorkerFirst` globs invoke the worker; a
missing entry returns the shell straight from the nearest edge. ADR
[0168](0168-d1-region-strategy-smart-placement-first.md)'s Smart Placement adoption explicitly rests
on this ("static assets are always served from the location nearest to the incoming request"). So
making the shell correct at first byte means routing HTML *through* the worker — pulling first-byte
HTML through a smart-placed (ENAM-biased) isolate. That is a real TTFB-vs-correct-first-paint
tension, and resolving it is what this ADR does.

Prior art (surveyed on the map) splits into: (a) build-time inline (Discord, per-channel);
(b) **per-request edge inline** — Cloudflare's own
[spa-shell recipe](https://developers.cloudflare.com/workers/examples/spa-shell/): HTMLRewriter over
the asset response + `window.__BOOTSTRAP_DATA__` + a client fetch-fallback when the payload is
absent; (b') edge-select among ≤2ⁿ pre-built cacheable permutations; (c) a cacheable static shell +
an inline script reading client-side hints (Linear's logged-in/geometry boot — the same shape as
phoenix's #697 pre-paint theme script). Every credible pattern decides **before** first byte/paint,
never after boot. This ADR adopts (b) for our exact stack.

## Decision

The worker renders the shell **fresh, per request** and injects an edge-resolved state payload the
client reads synchronously. Four founder rulings define the contract.

### 1. The geometry law (founder ruling [#2830](https://github.com/kamp-us/phoenix/issues/2830))

The above-the-fold line is drawn on **geometry, not data**. **Shell-critical = state whose wrong
value moves geometry at first paint.** That is exactly: the three nav-shaping flags
(`PHOENIX_NAV_IA`, `MECMUA_PUBLIC_READ`, `MECMUA_FEED`) + session **presence** (`signedIn`), **plus**
reserved chip *slots* when signed in. Chip *values* (karma, unread count, avatar) are **not**
shell-critical — they late-fill into fixed, reserved geometry from fate (the #2160 late-fill
ruling). Nothing else may gate shell geometry. The edge payload is therefore four booleans and no
fate data.

### 2. Per-request, non-cached, FULL render (founder ruling [#2833](https://github.com/kamp-us/phoenix/issues/2833))

Every hard reload renders the shell through the worker:
`runWorkerFirst: ["/*", "!/assets/*"]` (Cloudflare's canonical SPA shape) → the HTML route does
`env.ASSETS.fetch` + a **streaming HTMLRewriter** that appends
`<script>window.__BOOT__={…}</script>`. The payload is resolved per request: the session is **fully
validated** (3 serial D1 queries; signed-out costs zero D1) and the flags are evaluated under the
**userId** context — values identical to client-side evaluation, no divergence — plus `signedIn`.

**No `Cache-Control`.** The HTML is never cached; every hard reload renders fresh. Rejected: a
localStorage mirror (a second source of truth), and permutation precompute. **Accepted:** a
~70–80ms-class ENAM hop on first byte, offset by killing the post-boot fetch round-trip; ADR 0168's
premise is revised explicitly, and placement is watched via the `cf-placement` response header.

The named principle behind this ruling is **cohesiveness**: *one source of truth, everything renders
at the same time; correctness wins over milliseconds.* Full validation over a cheaper httpOnly
cookie-presence hint, non-cached over cached — both fall out of cohesiveness.

### 3. Unified `useFlag` + the shell-key manifest (founder ruling [#2834](https://github.com/kamp-us/phoenix/issues/2834))

**One `useFlag` path.** Keys that are members of `__BOOT__` resolve **synchronously**
(`loading: false`, no fetch); all other keys keep the existing fetch path. `__BOOT__.signedIn` drives
shell geometry while `useSession` settles.

The set of shell keys is a **shell-key manifest** — the same idiom as the fanned-mutations classifier
(ADR [0155](0155-fanned-mutation-publish-guard.md)): a single declared source consumed by *both* the
worker injection and the client, with a **fail-closed guard** so a shell key can never drift out of
sync between the two sides.

### 4. The never-hang invariant

`Effect.timeout` wraps the boot reads; on timeout or any Flagship/D1 failure the worker falls back to
the **untransformed asset response** — byte-identical to today's edge-direct shell. The client treats
`__BOOT__` as **optional** and keeps its fetch fallback when the payload is absent (the spa-shell
recipe's absence path). A Flagship outage therefore degrades to *current* behavior — safe defaults,
never a hung shell. This preserves the map's non-negotiable safe-default-on-outage invariant.

### Per-instance resolution table

The strategy is the law; each known pop-in resolves as an instance of it:

| Pop-in | Resolves as |
|---|---|
| [#2828](https://github.com/kamp-us/phoenix/issues/2828) — mecmua nav link | `MECMUA_PUBLIC_READ` in the shell-key manifest → in `__BOOT__` → nav geometry correct at first paint. The flag itself **stays** (live kill-switch — founder ruling); the fix is at the render/data layer, not flag removal. |
| `session.isPending` — giriş-yap ↔ user-cluster swap | the shell frame reads `__BOOT__.signedIn`; signed-in ⇒ reserved chip slots at first paint |
| chips (karma / bildirim / avatar) shift | slots reserved by `signedIn`; **values** late-fill from fate per #2160 — the geometry law |
| `MECMUA_FEED` — akış entry | shell-key manifest → `__BOOT__` |
| `PHOENIX_NAV_IA` — topbar restructure | shell-key manifest → `__BOOT__` |

### Non-goals

SEO / prerender is out of scope (its own future wayfinding session, per the mecmua map #2467).
Below-fold flags are unchanged on the existing fetch path. No localStorage mirror. No permutation
precompute.

## Consequences

- **ADR 0168 is amended, not superseded.** Its "assets never route through the worker" premise no
  longer holds for the HTML document route: HTML now routes worker-first and is subject to Smart
  Placement's per-worker ENAM bias. The accepted first-byte ENAM hop is offset by removing the
  post-boot flag-fetch round-trip. The in-source Smart Placement comment
  (`apps/web/worker/index.ts`, the placement block) must be rewritten with this amended premise, and
  placement effects watched via `cf-placement`.
- **ADR [0169](0169-no-session-caching-immediate-teardown-invariant.md) is untouched.** The shell is
  fully validated **per request** — there is no session caching and no teardown-latency change; 0169's
  immediate-teardown invariant stands unmodified.
- **ADR [0170](0170-workers-cache-via-alchemy-effect-pnpm-patch.md) is unaffected.** Viewer-dependent
  HTML (it carries `signedIn`) is **never** cached, so the cache substrate is not used for this
  response; presence must never enter a cached response.
- **The build epic implements against this ADR as law.** Emission is report → triage → plan-epic →
  the [#2926](https://github.com/kamp-us/phoenix/issues/2926) build epic; each child implements one
  instance of the contract, not a one-off patch. Implementation notes carried from the map's
  seam/cost investigations (#2831/#2832):
  - The `ASSETS` binding is already deployed by alchemy (unread today) — reachable via
    `WorkerEnvironment`.
  - `worker-routes.ts`'s lockstep contract needs a deliberate extension: `globMatches` does not model
    `!` exception patterns, and the HTML route has no `HttpRouter` mount yet.
  - The HTML route **reuses** the exact `validateSession` + `contextFromSession` +
    `makeRequestFlagsContext` path `/api/flags/evaluate` already uses — no new machinery.
- **Correctness is bought with first-byte latency.** The ENAM hop is a deliberate, cohesiveness-driven
  trade; if `cf-placement` analytics show it regressing light/anon paths beyond tolerance, the
  documented escape hatch is a second, non-placed shell worker (the placement collision is per-worker,
  CF-documented).

## Vocabulary impact

Two terms are coined here and should be surfaced to
[`.glossary/TERMS.md`](../.glossary/TERMS.md) via `/glossary` (a `report` is filed alongside the
build epic):

- **shell state (edge-resolved)** — the above-the-fold geometry-critical state (the three nav flags +
  `signedIn` + reserved chip slots) that the worker resolves and injects at the edge so the initial
  paint is already correct. Distinct from below-fold flag/data state, which stays on the client fetch
  path.
- **the `__BOOT__` contract** — the `window.__BOOT__` payload injected by the streaming HTMLRewriter
  and read synchronously by a unified `useFlag`; membership in it is defined by the **shell-key
  manifest** and enforced by a fail-closed guard across the worker/client seam.

The named organizing **principle — *cohesiveness*** (one source of truth, everything renders at the
same time; correctness wins over milliseconds) is recorded here as this ADR's governing rationale;
it is the founder-named justification for full-validation-per-request over cheaper hints.

## Relationship to prior decisions

- **Amends ADR [0168](0168-d1-region-strategy-smart-placement-first.md)** — revises its
  "assets are always served from the edge, the worker never touches HTML" premise for the HTML
  document route (now worker-first, smart-placed). The Smart-Placement-first strategy stands; the
  static-HTML premise is narrowed.
- **Leaves ADR [0169](0169-no-session-caching-immediate-teardown-invariant.md) intact** — full
  per-request session validation, no session caching.
- **Leaves ADR [0170](0170-workers-cache-via-alchemy-effect-pnpm-patch.md) intact** — viewer-dependent
  HTML is never cached.
- **ADR [0081](0081-feature-flag-substrate-cloudflare-flagship.md)** — the Flagship flag substrate;
  the shell flags are evaluated through it, server-side, under the userId context.
- **ADR [0155](0155-fanned-mutation-publish-guard.md)** — the fanned-mutations classifier idiom the
  shell-key manifest + fail-closed guard reuse.
- **ADR [0157](0157-realtime-is-a-core-ux-tenet.md)** — realtime correctness as a UX tenet; the
  cohesiveness principle is its first-paint expression.
- **ADR [0075](0075-issueless-doc-pr-merge-seam.md)** — this ADR is conversation-authored under 0075's
  exemption (no report → triage intake ticket).
