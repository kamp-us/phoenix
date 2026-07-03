---
id: 0128
title: Concept-Level Glossary Maintenance Triggers Off the Fail-Closed Gate — At Coinage + An Out-of-Band Backstop Sweep
status: accepted
date: 2026-07-02
tags: [pipeline, glossary, review, process]
---

# 0128 — Concept-Level Glossary Maintenance Triggers Off the Fail-Closed Gate — At Coinage + An Out-of-Band Backstop Sweep

## Context

The glossary (`.glossary/TERMS.md`) is the repo-owned domain vocabulary every contributor
and CI-spawned agent shares. Its only *automated* freshness signal today is the
`review-code` gate's **Step 3c — Glossary-freshness gate**
(`claude-plugins/kampus-pipeline/skills/review-code/SKILL.md`, §"Glossary-freshness gate").
That gate computes a `NEW_SURFACE` union from **structural path signals only**, read
read-only off the PR's file list against a freshly-fetched base:

- a new feature folder under `apps/web/worker/features/*` (absent on fresh base),
- a new public package (`packages/<pkg>/package.json` absent on base),
- a new public export from a package entry (an added `export …` in `packages/<pkg>/src/index.ts`).

If any structural surface is present and the PR does not touch `.glossary/TERMS.md`, the
gate FAILs (relevant-but-zero-match, ADR 0092 §ZS). If **none** is present it emits
`glossary-freshness: not applicable` and contributes no row.

That "not applicable" branch is the hole. A **concept-level** vocabulary shift *within
existing surfaces* — a renamed model, a redefined lever, an ADR-coined term — adds no new
folder / package / export, so `NEW_SURFACE` is empty and the gate stays silent. Two
grounded misses define the class the mechanism must catch:

- **[#1726](https://github.com/kamp-us/phoenix/issues/1726)** redefined the release lever
  ("effective serving" / "split release" / "kill") in a regular code PR that routed through
  no `/adr` — zero glossary pressure.
- **[ADR 0126](0126-ambient-adr-discovery.md)** coined "ambient discovery" while retiring the
  committed ADR index — an ADR-routed term, again zero glossary pressure.

Both landed silently; drift was caught only when the founder hand-invoked `/glossary`. The
`glossary` skill (`claude-plugins/kampus-pipeline/skills/glossary/SKILL.md`) is fully
capable of the incremental concept-level update, but has **no automated trigger** for this
case — it fires only on hand invocation or when `write-code` dispatches it for a *new
structural surface*.

This is platform/infra work — the agent pipeline and its gates — so per ADR
[0078](0078-product-driven-decisions-by-default.md) engineering leads the call. The reporter
laid out four architecturally distinct options (a/b/c/d); the founder's call selects a
combination and rejects one outright.

## Decision

**Concept-level glossary maintenance is triggered by TWO prongs, both OFF the fail-closed
`review-code` gate — never on the per-PR blocking path:**

### (c) Point-of-coining catch — a vocabulary-impact section in the coining skills

The `/adr` and `plan-epic` skills gain a **required vocabulary-impact section** that
feeds / flags `.glossary/TERMS.md` when a term is coined or redefined. A term most often
enters the vocabulary at the moment it is *named* — in an ADR or an epic plan — so catch it
**at its source**, where the author already has the concept in hand and the cost of naming
it is one section, not a later archaeology pass. ADR 0126's "ambient discovery" would have
been caught here.

### (b) Out-of-band backstop sweep — a periodic glossary-drift sweep

A periodic (scheduled agent / cron / loop) glossary-drift sweep **diffs recent merges
against `.glossary/TERMS.md`** and files / opens the drift it finds. This is the backstop
for what (c) structurally cannot reach: a concept-level vocabulary shift in a **regular
code PR that never routes through `/adr` or `plan-epic`** (the #1726 release-lever
redefinition class). (c) catches ADR/epic-routed terms at coinage; (b) sweeps everything
else after the fact.

### The two prongs are complementary, not redundant

(c) is *at coinage* and covers the routed-term class with zero lag but zero reach into
un-routed PRs; (b) is *after merge* and covers the un-routed class the coining hooks can
never see, at the cost of some lag. Together they close both halves of the concept-level
hole the structural gate leaves open — the routed terms (c) and the ambient code-PR drift
(b) — which is exactly the split the two grounded misses fall along.

### Where the trigger lives: OFF the fail-closed gate, explicitly

The concept-level trigger belongs **off the per-PR blocking path** — an out-of-band sweep
(b) plus a skill hook at coinage (c) — and **NOT on the fail-closed `review-code` gate**.
The gate **keeps its deterministic structural signals** (new folder / package / export) and
nothing more; concept-level detection moves off the blocking path entirely.

### Rejected: (a) extend the fail-closed Step 3c gate with judgment-based term detection

We explicitly **reject** option (a) — extending Step 3c to "PR introduces a new noun /
lever / ADR-defined term." A judgment-based facet on a **blocking, fail-closed** gate is the
wrong instrument:

- **False-positive FAILs.** "Is this a new *concept* or just a reused word" is a judgment
  call; on a fail-closed gate every ambiguous call that trips redward becomes a spurious
  FAIL that blocks a merge with no real defect behind it.
- **Merge friction.** Each false FAIL costs a full FAIL → repair round-trip the gate exists
  to *prevent*, turning the freshness check into a tax on unrelated PRs.
- **Eroded gate trust.** A blocking gate that fires on judgment loses the property that
  makes a fail-closed gate trustworthy — that a FAIL means a *real, deterministic* defect.
  Once reviewers learn to route around a noisy facet, the gate's deterministic facets lose
  authority too.

The gate's structural signals are deterministic and cheap precisely *because* they are
path-shaped; keeping concept-level judgment off the blocking path preserves that, and the
missed class is recovered off-path where a false positive costs a filed issue, not a blocked
merge.

Option (d) (keep hand-invoked `/glossary` + a reminder surface) is subsumed — the periodic
sweep (b) is the automated form of the "notice the drift" the founder was doing by hand, so
(d)'s reminder is unnecessary once (b) exists.

## Consequences

**Concrete follow-up work** — to be filed as a **separate implementing issue** (this ADR
records only the choice; it ships no skill or tool change):

- **(c)** Add a **vocabulary-impact section** to `claude-plugins/kampus-pipeline/skills/adr/`
  and `claude-plugins/kampus-pipeline/skills/plan-epic/` that feeds `.glossary/TERMS.md` when
  a term is coined or redefined.
- **(b)** Build the **periodic glossary-drift sweep** — a scheduled agent plus a `glossary`-skill
  or `pipeline-cli` mode that diffs recent merges against `.glossary/TERMS.md` and files / opens
  the drift.

Both changes land under `.claude/` / `claude-plugins/` — the control-plane surface — so the
implementing issue is a **§CP issue** on the **`review-skill`** path with **human merge**, not
an auto-shipped product PR. (This ADR itself is a `.decisions/` file — the non-§CP docs class,
`review-doc`-gated — and touches **no** skill.)

**What this makes easier.** Concept-level vocabulary drift is caught by an automated
mechanism instead of waiting for a human to sweep — at coinage for routed terms, after merge
for everything else — while the `review-code` gate stays deterministic and low-friction.

**What this makes harder / the cost.** The backstop sweep (b) **lags** merges by its cadence
— drift is caught after landing, not blocked before. That lag is the deliberate price of
keeping the concept-level check off the blocking path; a term that ships in a code PR is
un-glossaried until the next sweep. The coining hook (c) adds a required section to two
skills, a small authoring cost paid at the point the concept is already in hand.

**What is now banned.** Extending the fail-closed `review-code` Step 3c gate with
judgment-based new-noun / lever / term detection. The gate keeps its structural signals only;
concept-level detection is off the per-PR blocking path by decision, not by omission.
