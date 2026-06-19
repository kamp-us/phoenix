---
id: 0086
title: ship-it degrades its run-evidence guard in a foreign repo (producer-presence, not per-PR escape)
status: accepted
date: 2026-06-18
tags: [pipeline, plugin-portability, ship-it, run-evidence]
---

# 0086 — ship-it degrades its run-evidence guard in a foreign repo (producer-presence, not per-PR escape)

## Context

`ship-it` is part of the distributable pipeline plugin (ADR [0062](0062-repo-as-config-plugin.md), repo-as-config). Its Step 3.5 / guard 2 hard-requires the **run-evidence bundle** — a SHA-bound `manifest.json` proving which suites ran for the head commit (ADR [0054](0054-run-evidence-bundle.md) §3, stored per ADR [0056](0056-bundle-storage-transport.md)).

That bundle is produced by **phoenix CI infrastructure the plugin does not ship**: `.github/workflows/run-evidence.yml` running `packages/crabbox-manifest`. The plugin distributes *skills*, not workflows (ADR [0053](0053-control-plane-boundary.md): `.github` is control-plane, not shipped). So in a foreign repo that installed the pipeline, **no run-evidence bundle is ever produced → guard 2 never clears → ship-it declines every merge** — it is non-functional as the pipeline's merge step (#425).

This is a portability axis **not** covered by ADR [0062](0062-repo-as-config-plugin.md) (which targets *which repo* the skills operate on) nor by the npm-publish audit (#423, *which packages* resolve). It is the **CI-infrastructure** axis: a skill's gate depends on a producer the plugin doesn't distribute. `review-code` reads the same bundle but **degrades gracefully** ("a missing bundle is never an error" — it falls back to CI checks), so it is already foreign-safe; `ship-it` is the one with the hard dependency. (`heal-ci` similarly assumes phoenix CI shapes — out of scope here.)

The disposition was the open fork in #425: (a) **degrade like review-code**, (b) **ship the run-evidence workflow + crabbox-manifest** with the plugin, or (c) **document run-evidence as phoenix-only** and scope ship-it's portable contract to the check-set path.

## Decision

**Adopt (a): guard 2 degrades on producer-presence, mirroring review-code.**

1. **Producer-presence test, not a per-PR escape.** Before the bundle assertions, ship-it asks whether *this repo* produces run-evidence at all — a workflow named `run-evidence` defined on the default branch (`gh api repos/$REPO/actions/workflows`). The signal is the **producer's existence**, never the bundle's absence for a given PR.
   - **No producer** (foreign repo) → guard 2 is **N/A**; the gate falls back to the checks-green read (Step 3). The bundle becomes a phoenix optimization, not a hard gate. Reported distinctly: `guard 2 N/A (no run-evidence producer in this repo) — gated on checks (Step 3)`.
   - **Producer present** (phoenix home repo, or any adopter that ships the workflow) → the strict path runs **unchanged**: the four fail-closed assertions (exists, schema-`1`, commit-bound to head SHA, every `checks[]` pass) still gate the merge.

2. **A present-but-failing bundle still refuses.** A repo that *has* the producer but whose bundle is missing/stale/schema-skewed/failing for this commit is a **real gap, not portability** — it refuses below as today. Degradation is keyed only to "the repo is not set up to produce run-evidence," distinguishable from "it is, but this PR lacks it."

3. **Safe because Step 3 still gates.** The degrade path is reached only after Step 2 (current-head PASS) and Step 3 (every *gating* check green; an unrecognized red is gating by default, ADR [0061](0061-ship-it-gating-check-set.md)) have held. A foreign repo without a producer still blocks on its own red checks; degradation removes only the SHA-bound corroboration, not the merge gate.

## Consequences

- **ship-it is functional as the merge step in a foreign repo** — it gates on checks-green, the same contract review-code already honors.
- **Zero behavior change in the home repo** — phoenix ships `run-evidence.yml`, so `HAS_PRODUCER ≥ 1` and the strict four-assertion path is unchanged; the SHA-bound bundle remains the authority where it exists.
- **The degrade outcome is a distinct, non-refusing report line**, not one of the four refusal reasons — a human reading the run can tell "this repo doesn't produce run-evidence" from "this PR's bundle failed."
- **Rejected (b) ship the workflow + crabbox-manifest:** that would distribute CI infra and a producer package through a skills-only plugin — a larger surface (an epic), and it forces adopters onto phoenix's exact CI shape. Out of scope; revisitable if adopters want SHA-bound evidence.
- **Rejected (c) document phoenix-only:** leaves ship-it non-functional in a foreign repo, defeating the plugin's headline portability claim.
- **Relates to:** ADR [0062](0062-repo-as-config-plugin.md) (repo-as-config — the targeting axis this complements), [0054](0054-run-evidence-bundle.md)/[0056](0056-bundle-storage-transport.md) (the bundle this degrades), [0061](0061-ship-it-gating-check-set.md) (the check-set the degrade path falls back to), [0053](0053-control-plane-boundary.md) (`.github` not shipped — the root cause). Same foreign-repo-hardening front as #592 (manifest drift), #484 (packaging), #460 (preflight doctor).
