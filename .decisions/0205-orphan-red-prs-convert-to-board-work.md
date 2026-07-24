---
id: 0205
title: Orphan red PRs convert to board work — engines never free-scan-adopt
status: accepted
date: 2026-07-24
tags: [pipeline, crew]
---

# 0205 — Orphan red PRs convert to board work — engines never free-scan-adopt

**What this decides:** When a hand-authored PR goes red on CI and no engine owns it, the pipeline does not let engines scan for and grab it directly — instead a detector files a normal claimable "heal" issue for it, and an engine picks that up like any other board work.

## Context

The engine self-drain loop (the crew `engineering-manager`, ADR [0189](0189-crew-roster-law-bridges-engines.md)) heals a PR **only inside a lane it owns** — a `reviewer` FAIL on an engine-opened PR routes to `coder` repair. It has no step that scans open red PRs and adopts **orphans**: a hand-authored PR that goes red on a **CI check** (not a reviewer FAIL) sits in no engine lane, is invisible to the pull loop, and is never healed. Live instance: #3501 (red on leak-guard, no lane), worked around by the manual heal-lane #3531. Issue #3532 posed the design question: should the drain free-scan-adopt orphan red PRs, or is the lane boundary intentional? Sibling decision: #3534 (`EngineNudge`, the narrow chief-of-staff→engine targeting edge) — the two were to be decided coherently.

## Decision

**The founder ruled (2026-07-19): BOUNDARY (structural) — engines do NOT free-scan-adopt orphan red PRs; an orphan red PR is converted into pullable board work, then adopted through the normal pull loop.**

Engines heal only lanes they own; an orphan red PR is *converted into a lane* first, then adopted. Mechanics:

1. **Detector** — a scheduled scan (a GH Action cron or a crew poller, **not** the chief-of-staff) lists open PRs and flags an orphan when **all** of: open, **not draft**, **CI-red on head**, **in no engine lane** (not opened-from-a-triaged-issue by an engine, no active claim), and red for longer than a short grace window (so it never grabs a PR mid-CI).
2. **Heal-item emitter** — files a triaged, immediately-claimable issue "heal red CI on PR #N" pointing at #N + the failing check. **Idempotent**: one heal-item per PR; skip if one exists.
3. **Engine pulls it** as normal claimable work → now owns a lane bound to #N.
4. **Heals in-lane** using the existing diagnose→repair→re-run-CI machinery — unchanged, just pointed at the adopted PR.
5. **Green → close** the heal-item; #N proceeds normally (review/ship, or bank if §CP).

Free-scan adopt was **rejected** because it broadens the engine's mutation authority to PRs whose intent it doesn't own — it could repair against author intent, or grab intentional WIP. The invariant preserved: **the engine never touches a PR outside a lane it owns**; the detector converts the orphan into a lane *first*.

Reconciled with #3534: this ADR is the structural orphan path (board-native — it works even if the chief-of-staff is asleep); `EngineNudge` (#3534) is founder-directed targeting. Complementary, not contradictory.

**Binding constraints.**
- Engines never mutate a PR outside a lane they own; orphan adoption always goes detector → heal-item → pull.
- The detector's orphan predicate is the conjunction: open ∧ not-draft ∧ CI-red-on-head ∧ no-engine-lane ∧ red past the grace window.
- Heal-item emission is idempotent — one heal-item per PR, ever-open at most one.
- The detector is a scheduled scan (cron/poller), not a chief-of-staff duty.

**Banned.**
- A free-scan-adopt step in any engine's drain loop.
- A detector that flags draft or mid-CI (inside-grace-window) PRs.

## Consequences

- **New build = steps 1–2 only** (the detector + the heal-item emitter); steps 3–5 reuse the existing drain/repair loop unchanged. The implementation follow-up is filed separately — #3532 is the tracking origin.
- Hand-authored PRs (ADR PRs included) that go CI-red now have a board-native path to healing; #3531-style manual heal lanes stop being the workaround.
- Cost: healing an orphan incurs the grace window + the issue hop before an engine touches it — accepted latency, the price of keeping engine mutation authority scoped to owned lanes.

## Records

- Decision source: founder ruling on #3532 (2026-07-19). References #3532 (build work remains); companion to #3531 (the immediate manual heal) and #3534 (`EngineNudge`).
- Vocabulary impact: coins **orphan red PR** (an open, non-draft, CI-red-on-head PR in no engine lane, red past the grace window) and **heal-item** (the triaged, immediately-claimable issue that converts an orphan into an engine lane) — both routed to [.glossary/TERMS.md](../.glossary/TERMS.md) in this PR.
