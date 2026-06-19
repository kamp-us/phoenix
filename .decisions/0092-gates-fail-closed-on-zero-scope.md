---
id: 0092
title: Every Gate Fails Closed When Its Enforcement Scans Zero Scope (No Silent No-Op Gates)
status: accepted
date: 2026-06-19
tags: [process, pipeline, ci, gates]
---

# 0092 — Every Gate Fails Closed When Its Enforcement Scans Zero Scope (No Silent No-Op Gates)

## Context

The operation's signature failure mode is the **silent-no-op gate**: a gate whose enforcement keys off an upstream marker nobody ever sets, so it runs on every event, fires on **none**, and reads **PASS forever**. A gate that only ever exercises its no-op branch rots undetected — it manufactures confidence while protecting nothing.

Confirmed in 7+ places:

- The **flag substrate** — built, never consumed (see ADR [0091](0091-infra-epics-need-a-real-consumer.md)).
- The **containment marker** — `Containment: flag` on 0 of 300+ issues.
- **`review-code`'s flag-gating check** — its precondition is never set, so it always reads `none` and waves the PR through.
- **`ship-it`'s dark-merge branch** — keys off the same unset marker.
- The **CI cycle test** — only proves the foreign-repo *absent* path, never the present-and-cyclic path.
- The **meta-gates themselves** — [#587](https://github.com/kamp-us/phoenix/issues/587) / [#562](https://github.com/kamp-us/phoenix/issues/562) / [#559](https://github.com/kamp-us/phoenix/issues/559) ("STOPS SELF-NO-OPPING"), and [#237](https://github.com/kamp-us/phoenix/issues/237) (biome silently skipping `.claude`).

Each was patched in isolation. The class is the problem, and the class lives at the meta-layer: **a gate that cannot fail is worse than no gate.**

## Decision

**Every gate fails closed when its enforcement scans zero scope.**

Every gate's enforcement step must:

1. **Emit what it scanned** — file count, matched paths, the set of events considered. Gates become observable; "what did this gate actually look at" is answerable from its output.
2. **FAIL CLOSED when a relevant PR/event yields zero matches.** "Scanned nothing" is a **FAIL**, never a silent PASS.

Applies to `review-code` / `review-doc` / `review-skill`, `ship-it`, the epic-ledger validators, and the CI cycle / convention checks.

## Consequences

- **Kills the silent-no-op class at the meta-layer** with one invariant instead of patching each gate forever after it rots.
- **Gates become observable** — every run states its scope, so a gate that quietly stopped matching is visible immediately.
- **A gate that can't fail is treated as worse than no gate** (it manufactures false confidence) — the design bias flips from "default PASS, fail on detect" to "default FAIL, pass on positive evidence of scope."
- **Cost:** requires retrofitting existing gates to emit scope + fail-closed (tracked by the "make the gates fire" epic); a legitimately-empty scope (e.g. a docs-only PR hitting a code gate) must be expressed as an explicit *not-applicable* skip, not an accidental zero-match PASS.
- **Relates to:** ADR [0091](0091-infra-epics-need-a-real-consumer.md) — the unconsumed capability and the unfiring gate are the same failure mode (built-but-not-exercised) at two layers; both are surfaced by the doctrine-drift reconciliation job.
