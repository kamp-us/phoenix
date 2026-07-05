---
id: 0157
title: "Real-time / live updates are a core, non-negotiable phoenix UX tenet — a feature that displays state others can change is not \"functionally whole\" until it live-updates"
status: accepted
date: 2026-07-05
tags: [product, ux, fate-live, live-views, prioritization, definition-of-done]
---

# 0157 — Real-time is a core phoenix UX tenet, not a parkable follow-up

> **ADR-number note.** origin/main's last ADR is 0155; 0156 is claimed by in-flight PR
> #2112 (health-probe). This ADR takes the next free number, **0157**, verified free across
> all open PRs at authoring time.

## Context

Deciding whether reaction live-count deltas over `LiveDO` (#1868) should build now or be
parked under an active scope freeze, an agent recommended parking it as "real-time polish."
The founder corrected that framing, stated verbatim:

> **"we should never consider realtime updates as a follow-up. it's a core part of the
> phoenix experience. snappy controls, almost app like navigation. no compromise."**

This is a product tenet, and until now it was not written down anywhere authoritative.
Because it was unwritten, an agent mislabeled live-update work as parkable polish — the
exact failure this ADR exists to prevent. Per ADR
[0078](0078-product-driven-decisions-by-default.md) (product-driven decisions by default), a
product-experience tenet is exactly an ADR's job — the deliverable is a *recorded choice*, a
product principle, not code.

The live substrate already exists — it is not the thing being decided here. fate-live's
`/fate/live` SSE fan-out over the unified `LiveDO` (ADRs
[0023](0023-live-views-sse-livedo.md) / [0025](0025-split-livedo-connection-topic.md) /
[0037](0037-unified-void-aligned-live-do.md); see also
[0125](0125-optimistic-reconciliation-live-driven-nested-connections.md)) is the *mechanism*
that makes real-time the default rather than an add-on. Those ADRs record the mechanism; none
of them states the *product tenet* that real-time is non-negotiable or that it defines
"functionally whole." That tenet is net-new knowledge, and this ADR records it.

## Decision

Real-time / live updates are a **core, non-negotiable part of the phoenix experience**
(snappy controls, almost app-like navigation, no compromise) — **never** a parkable
follow-up.

The tenet reshapes what **"functionally whole"** means for a phoenix feature:

- A feature that displays **state others can change** — counts, reactions, presence, live
  views — is **not "functionally whole" until it live-updates**.
- Live-update work is part of **finishing** a feature, not a separable "nice-to-have"
  ticket. It is not a deferrable polish pass and not a separate follow-up.
- The fate-live / `LiveDO` SSE substrate (see
  [.patterns/fate-live-views.md](../.patterns/fate-live-views.md)) is the **default
  mechanism** that makes real-time the default, not an add-on. A feature that shows
  shared-mutable state and does not opt its view into live (`useView` → `useLiveView`) is
  incomplete by construction.

### Teeth

- **Feature acceptance.** A feature that displays state others can change does not meet its
  acceptance criteria until it live-updates. Reviewers hold the same bar: a fanned feature
  that renders shared-mutable state without live-updating is not "done."
- **Triage sizing.** Triage does not split real-time out into a separate "nice-to-have"
  ticket to be deprioritized later. Real-time is folded into the feature's own scope so that
  "done" includes it by default. A live-update sub-ticket is only legitimate as a *tracking*
  aid within a feature's scope, never as a park-it-for-later carve-out.
- **No re-making the polish mistake.** No agent may re-label live-update work as parkable
  polish; this ADR is the authoritative counter to that framing.

## Enforce vs. record — the split with the fanout-guard

This ADR **records** the *why*; the CI fanout-guard **enforces** a mechanical slice of it.

- ADR [0155](0155-fanned-mutation-publish-guard.md) (the fanned-mutation publish guard)
  classifies every mutation fanned/not in a manifest and **fails the build** when a fanned
  mutation omits its post-write `/fate/live` publish. That guard is the *enforcement
  mechanism* — it catches the server-side omission (a mutation that writes a fanned entity
  but never publishes the invalidation, leaving every other client's live view stale).
- This ADR is the *product-experience tenet behind that guard* — the reason the guard is
  worth having, and the broader principle it is one enforcement of. The guard covers the
  server publish; the tenet covers the whole loop, including the client-side obligation to
  subscribe the view (`useLiveView`) so the published invalidation actually re-renders.

The two are distinct units: #1887/#1898 built the *enforcement*; #2045 records the *tenet*.

## Consequences

- Feature-acceptance, triage-sizing, and "done" definitions fold real-time in by default;
  the pipeline stops splitting real-time out into deprioritized follow-up tickets.
- Features feel app-like (live) rather than refresh-driven, which is the core experience the
  founder named non-negotiable.
- Cost: features that show shared-mutable state carry live-update work inside their own
  scope, so they are sized larger up front rather than shipping a hollow first cut.

## Related

- **Substrate (mechanism):** ADRs [0023](0023-live-views-sse-livedo.md) /
  [0025](0025-split-livedo-connection-topic.md) / [0037](0037-unified-void-aligned-live-do.md)
  / [0125](0125-optimistic-reconciliation-live-driven-nested-connections.md);
  pattern doc [.patterns/fate-live-views.md](../.patterns/fate-live-views.md) (how a view
  opts into live, and how mutations publish the invalidation).
- **Enforcement:** ADR [0155](0155-fanned-mutation-publish-guard.md) — the CI fanout-guard
  that fails the build on a fanned mutation missing its `/fate/live` publish. Enforcement
  epic #1887 (systemic audit + guard).
- **Triggering instance:** #1868 (reaction live-count deltas over `LiveDO`), companion to
  #1867 (reaction UI) — the live-update work that was almost parked as polish.
- **Product-decision authority:** ADR [0078](0078-product-driven-decisions-by-default.md)
  (product-driven decisions by default).
