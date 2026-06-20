---
id: 0093
title: Pano draft-save is the flag substrate's first real consumer
status: accepted
date: 2026-06-19
tags: [product, flags, pano]
---

# 0093 — Pano draft-save is the flag substrate's first real consumer

## Context

The feature-flag substrate and dark-ship machinery (epic [#736](https://github.com/kamp-us/phoenix/issues/736)) exist but gate **zero** real features today. ADR [0091](0091-infra-epics-need-a-real-consumer.md)'s forcing function — infrastructure isn't done until a product feature consumes it in production — is therefore **undischarged**: the only `getBoolean` consumer is the synthetic `phoenix-health-probe`.

[#745](https://github.com/kamp-us/phoenix/issues/745) is the `type:decision` that picks the first real consumer. The pano write-flows (vote / save / submit / comment) are **already shipped end-to-end**, so there is no write-flow left to build — the leverage is a *new* user-facing surface shipped dark. The inert "taslak" (draft) button on `PanoSubmitPage` ([#696](https://github.com/kamp-us/phoenix/issues/696)) is an open, tracer-sized gap that fits exactly.

## Decision

**Dark-ship pano "taslak" (draft-save) as the flag substrate's first real consumer.**

- **D1-backed, not localStorage.** Build a real `post.saveDraft` / `post.discardDraft` mutation, a fate `isDraft` view scalar, and `live.update` wiring. The whole point is to consume the determinism / live infra **in production** — localStorage-only was **rejected** because it wouldn't exercise the live/determinism path, so it wouldn't be a real consumer.
- **Gated by a boolean, default-off flag, key `pano-draft-save`.** Off ⇒ today's behavior (no draft surface). On ⇒ the draft-save surface. This resolves [#696](https://github.com/kamp-us/phoenix/issues/696) via the new-feature arm.
- **Lane division:**
  - *Determinism lane* — worker write-path + the flag-default-equals-safe-state invariant test.
  - *Harness lane* — React UI + e2e + release plumbing.
- **Shared contract:** flag key `pano-draft-save`; mutation `post.saveDraft` returning the re-resolved draft row with `isDraft`.

## Consequences

- **Discharges ADR [0091](0091-infra-epics-need-a-real-consumer.md)** for the flag substrate — this is its first real consumer. [#746](https://github.com/kamp-us/phoenix/issues/746) (ship dark) and [#747](https://github.com/kamp-us/phoenix/issues/747) (verdict) follow.
- **Kills [#696](https://github.com/kamp-us/phoenix/issues/696).**
- **Establishes the dark-ship loop** on a real feature: default-off invariant test → `status:awaiting-release` → human flip.
- **Cost:** a new D1 column / table + migration; the off-path must stay safe, pinned by a default-off invariant test (per [`feature-flags-agent-workflow.md`](../.patterns/feature-flags-agent-workflow.md)).
