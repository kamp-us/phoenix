---
id: 0106
title: IaC Provisions Feature Flags; the Dashboard Owns Their Serving
status: accepted
date: 2026-06-21
tags: [process, release-engineering, feature-flags]
---

# 0106 — IaC Provisions Feature Flags; the Dashboard Owns Their Serving

## Context

ADR [0083](0083-agents-deploy-humans-release.md)'s release model — agents deploy, humans release by flipping the dashboard flag — could not stick. Alchemy's `FlagshipFlag.reconcile` rebuilds the full flag body from its IaC declaration and fires a non-preserving PUT on every deploy, reverting any dashboard change (observed: merges #831 and #833 each clobbered the `pano-draft-save` rollout back off). Reads were never implicated — `Flags.getBoolean` asks the Flagship server, which already reflects live serving; only the deploy-time reconcile collides with dashboard state.

## Decision

One model, for every flag, with no per-flag opt-in: **IaC (the `FlagshipFlag` resource) owns the flag's *existence* and *variation schema*** — creation, deletion, the variation key/value set, and the safe initial default written at create. **The dashboard owns the *serving config*** — targeting rules, rollout / percentage-split, the served default after create, and `enabled` — as runtime state that deploys never reconcile.

The governing analogy: `alchemy deploy` provisions a D1 database (and its schema) but never its rows; a flag deploy provisions the flag (and its variation schema) but never its serving.

**Why keep IaC at all rather than drop alchemy and hand-create flags on the dashboard:** agent autonomy. IaC flag creation lets an agent ship a dark feature end to end — declare the flag, gate the code, deploy — with no human dashboard step, and the flag appears in every stage automatically. Dropping IaC would make flag creation human-only, a bottleneck on every flagged feature. Reviewable structure is a side benefit; agent autonomy is the load-bearing reason.

## Mechanism

A repo-local `pnpm patch` on `alchemy` (per ADR [0038](0038-dependency-patches-local-only.md) — NOT a fork) to `FlagshipFlag.reconcile`: on create, write the full safe initial flag; on update, reconcile only `{variations, description}` and carry the live `{defaultVariation, rules, enabled}` forward — read-before-write, never clobber. Tracked as implementation issue [#1180](https://github.com/kamp-us/phoenix/issues/1180).

## Consequences

- Deploys are safe to run at any time — they never revert a release.
- Serving config is deliberately NOT version-controlled (it is runtime data, like D1 rows).
- The demo flag's IaC-declared rules become a create-time seed rather than authoritative-on-update — no special-casing, the one model covers it.
- The alchemy patch re-keys on each alchemy version bump (the existing patch-maintenance ritual).
- **Affirms** ADR [0083](0083-agents-deploy-humans-release.md) (agents deploy, humans release) — makes its release-time human flip durable against deploys. Resolves [#840](https://github.com/kamp-us/phoenix/issues/840). Feeds [#747](https://github.com/kamp-us/phoenix/issues/747).
