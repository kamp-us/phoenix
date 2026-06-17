---
id: 0081
title: The feature-flag substrate is Cloudflare Flagship (managed, edge-native), not a bespoke KV/D1/DO flag store
status: proposed
date: 2026-06-16
tags: [infrastructure, release-engineering]
---

# 0081 — The feature-flag substrate is Cloudflare Flagship

## Context

Epic [#488](https://github.com/kamp-us/phoenix/issues/488) ("Build a framework-level feature-flag
system — containment for autonomous shipping") is the forcing work. Shipping is now **autonomous and
no-eyeball**: PRs auto-merge on a green gate stack, and **every auto-merge is immediately live**. There
is no infra-level way to (a) ship code **dark** and flip it on later, (b) roll out to a **subset /
percentage**, (c) **kill-switch** a feature without a redeploy, or (d) gate an **agent-shipped** feature
behind a flag until a human or agent validates it. Gating today is ad-hoc — the `ENVIRONMENT` `Config`
var, hardcoded conditionals, branch/PR toggling — and the pipeline's control-plane boundary is
**path-based** ([0053](0053-control-plane-boundary.md) / [0065](0065-gate-critical-skills-are-blocking.md)),
a *merge-time* gate ([0065](0065-gate-critical-skills-are-blocking.md) refines its scope). Feature flags
are the complementary **runtime** gate: they **decouple deploy from
release**, the missing containment layer for a high-throughput autonomous pipeline (ship-behind-flag →
flip when validated). This is the safety valve #488 exists to build, and it must rest on a chosen
substrate before the epic can be planned.

Per [0078](0078-product-driven-decisions-by-default.md) (decisions are product-driven
by default; **engineering leads on platform/infra**), the substrate is an engineering call — it is not a
product-experience fork. The stack is **Cloudflare Workers + D1 + alchemy** (no `wrangler.jsonc`; the
stack is `apps/web/alchemy.run.ts`, ADR [0026](0026-adopt-alchemy-effect-infra.md) /
[0057](0057-multi-app-multi-worker-repo.md)), and #488 states a hard constraint: **no extra round-trip, no
third-party edge dependency** — the flag store must live in the same edge runtime as the request.

Candidates evaluated against the four capabilities plus edge-read latency, consistency, write path, and
how a server-eval + React-client-hook API sits on top:

- **A managed Cloudflare feature-flag product — verified to exist.** Cloudflare **Flagship** is an
  edge-native feature-flag service, **in public beta as of 2026-05-26**. It is backed by **Workers KV +
  Durable Objects** (a per-app Durable Object is the SQLite-backed source of truth + changelog; config
  is synced to KV and replicated across the network), evaluated **inside the Worker via a native binding
  with no outbound HTTP**, and is **OpenFeature-compatible** (the `@cloudflare/flagship` SDK is an
  OpenFeature provider for Workers, Node, and the browser). It supports typed variations
  (boolean/string/number/object), targeting rules (11 operators, AND/OR grouping), **percentage rollouts
  with consistent hashing** (stable per-`userId` bucketing), disable-to-default (the kill-switch), and
  dashboard audit history. Flag changes "take effect globally within seconds of saving" and evaluation
  keeps working from last-propagated config if the dashboard is unavailable. This is the exact
  CF-native, same-edge, no-third-party-round-trip shape #488 asks for — *as a managed product*, not a
  thing we build.
- **Bespoke CF-native stores** (the build path): **Workers KV** (edge-read, eventually consistent — a
  flag store but no targeting/rollout/audit engine), **D1** (already bound; strong-ish but **not
  edge-local** — a per-request read against the bound DB is the round-trip #488 forbids), **Durable
  Objects** (consistent state + natural per-user/percentage targeting, with the existing `LiveDO`
  precedent, ADRs [0023](0023-live-views-sse-livedo.md)/[0025](0025-split-livedo-connection-topic.md)/[0028](0028-effect-durable-object-model.md)).
  Notably, **Flagship is built on exactly KV + DO** — i.e. the best bespoke design *is* Flagship's
  internal design, minus the targeting engine, propagation, dashboard, audit log, and OpenFeature
  surface we would otherwise hand-roll and maintain.
- **Third-party** (Unleash / Flagsmith / LaunchDarkly): each adds a **third-party edge dependency and an
  outbound round-trip** (or a self-hosted store to operate) and a cost model — the two things #488
  rules out. Rejected on the stated constraint.

## Decision

The feature-flag substrate is **Cloudflare Flagship** — the managed, edge-native feature-flag service —
not a bespoke KV/D1/DO flag store and not a third-party provider.

- **Buy (adopt) over build.** Flagship delivers all four #488 capabilities natively: ship dark + flip on
  (disabled flag → default variation; flip in the dashboard), percentage / subset rollout (targeting
  rules + consistent-hash bucketing), redeploy-free kill-switch (disable the flag; propagates within
  seconds), and gate-an-agent-shipped-feature-pending-validation (merge behind a default-off flag; a
  human or agent flips it). It runs **in-isolate via a native Worker binding** — no outbound HTTP, no
  third-party edge dependency — satisfying #488's hard constraint, on the same Workers+KV+DO substrate
  the repo already runs. Building our own KV/DO flag service would re-implement Flagship's internals and
  own the targeting engine, propagation, audit log, and OpenFeature surface as maintenance — unjustified
  when the managed product is CF-native and meets the constraint.

- **Framework-API shape.** Flag evaluation is **server-side in the Worker** through the binding (the
  `get*Value(flagKey, defaultValue, context)` family — async, never-throws, falls back to `defaultValue`
  on error), wrapped as a phoenix isolate-level service the way other feature services are
  ([0029](0029-worker-runtime-servicemap.md)) with the per-request **evaluation context** (auth
  identity / `userId` for stable bucketing) supplied per request alongside `Auth`. The client surface is
  a **React hook** over server-evaluated values (Flagship's OpenFeature client provider pre-fetches and
  evaluates from an in-memory cache). The binding is declared in `apps/web/alchemy.run.ts` (there is no
  `wrangler.jsonc`).

- **Relationship to the control-plane boundary.** Flags are a **runtime release gate**, complementary to
  — not a replacement for — the **merge-time, path-based** control-plane boundary
  ([0053](0053-control-plane-boundary.md)/[0065](0065-gate-critical-skills-are-blocking.md)). The path
  boundary governs *what auto-merges*; flags govern *what is live after merge*. Both stand.

- **Scope.** This ADR fixes the **substrate** (Cloudflare Flagship) and the **framework-API shape**
  (server-eval binding-backed service + React client hook). Finer design — the flag schema/naming
  convention, targeting-rule taxonomy, environment/stage mapping, the agent's ship-behind-flag → flip
  workflow, and the alchemy binding declaration — is **deferred to the #488 plan-epic**.

## Consequences

- **Decouples deploy from release.** Autonomous merges can land dark and be flipped on after
  validation; a bad live feature is killed by disabling its flag (seconds, no redeploy) rather than a
  revert-and-redeploy cycle. This is the containment layer the no-eyeball pipeline was missing.
- **Adds a managed-product dependency on a public-beta service.** Flagship is **in public beta**
  (2026-05-26) — API/SDK surface and limits may shift, and beta SLAs apply. The plan-epic must treat
  beta-maturity (quotas, stability, GA timeline) as an explicit risk and confirm it is acceptable for
  the containment role before flags become load-bearing.
- **alchemy binding support is unverified.** The vendored `alchemy` package exposes **no `Flagship`
  resource today** (grep: none), and Flagship's documented setup is a `wrangler.jsonc` `flagship` block —
  which phoenix does not use ([0026](0026-adopt-alchemy-effect-infra.md)/[0057](0057-multi-app-multi-worker-repo.md)).
  The plan-epic must establish how the Flagship binding is declared in `alchemy.run.ts` (a native alchemy
  resource if/when one exists, a generic/raw binding otherwise, or an upstream alchemy patch per the
  fork/patch policy [0038](0038-dependency-patches-local-only.md)). **This is the chief integration unknown.**
- **OpenFeature keeps the exit open.** Because the SDK is an OpenFeature provider, a later swap to a
  different OpenFeature-compatible backend is a provider change, not an application rewrite — bounding
  vendor lock-in.
- **Eventual-consistency window is accepted.** Flips propagate "within seconds"; during the propagation
  window some regions briefly serve the prior value. Acceptable for release gating; not a strong-
  consistency primitive for correctness-critical state.
- **Banned (once adopted):** standing up a parallel bespoke KV/D1/DO flag service for the same job;
  introducing a third-party flag provider that requires an outbound edge round-trip; and continuing to
  add ad-hoc `ENVIRONMENT`-var / hardcoded-conditional gating for runtime feature toggles in new work.
- **Proposed, not accepted:** this is a directional build-vs-buy on a public-beta dependency; it is
  recorded `proposed` for a human to weigh in before it is locked and before the #488 plan-epic builds on
  it.
