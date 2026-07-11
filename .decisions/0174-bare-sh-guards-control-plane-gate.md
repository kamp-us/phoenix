---
id: 0174
title: "PROPOSED — Gate-critical bare `.sh` guards under `skills/` are control-plane (broaden `CONTROL_PLANE_RE` to `skills/[^/]+\\.sh$`)"
status: proposed
date: 2026-07-11
tags: [pipeline, control-plane, security]
---

# 0174 — Gate-critical bare `.sh` guards escape `CONTROL_PLANE_RE` → auto-mergeable without the §CP human gate

## Context

`CONTROL_PLANE_RE` is the single canonical control-plane classifier — the regex that
decides whether a PR is §CP (human-merge-gated by a `@kamp-us/control-plane` approval, ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)) or non-blocking
(auto-mergeable on a clean gate). It is defined **once** in
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` (line 1359, §CP) and copied
verbatim into the gate consumers; `ship-it` Step 0 resolves it from `origin/main` at run time
and classifies against it (`ship-it/SKILL.md` §Step 0, lines 190–266). Its
`claude-plugins/kampus-pipeline/skills/` alternative is:

```
^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan)/
```

— it matches only a **gate subdir** (note the trailing `/`), plus the exact file
`^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\.md$`. A **bare `.sh` sitting
directly under `skills/`** matches neither alternative.

Four gate-critical guards live exactly there, as bare `.sh` files (verified against source,
`ls claude-plugins/kampus-pipeline/skills/*.sh`):

- `claude-plugins/kampus-pipeline/skills/validate-gate-path-drift.sh` — locks the
  `CONTROL_PLANE_RE` / `GUARD_ADR_RE` copies byte-identical to the §CP canonical (its own
  header, lines 5–141).
- `claude-plugins/kampus-pipeline/skills/validate-cycle-absence.sh`
- `claude-plugins/kampus-pipeline/skills/validate-cycle-presence.sh`
- `claude-plugins/kampus-pipeline/skills/validate-skills.sh`

Because none of their paths match `CONTROL_PLANE_RE`, a PR touching **only** one of them
classifies non-§CP / non-blocking at `ship-it` Step 0, and on a clean review gate `ship-it`
would auto-merge it with no `@kamp-us/control-plane` approval. This is a self-approval-adjacent
control-plane integrity gap: an agent could author and auto-ship a change that weakens the very
guard protecting the gate-classification surface — the guard's protection is **not
self-covering**. Surfaced during review of PR #2522; filed as
[#2525](https://github.com/kamp-us/phoenix/issues/2525).

This is the **path/classification** axis of the same fail-open class ADR
[0164](0164-guard-relaxing-adr-cp-gate.md) already closed on the **content** axis: 0164 added a
content-inferred §CP clause (`GUARD_ADR_RE`) so a guard-*relaxing* `.decisions/**` ADR — whose
path is an ordinary ADR's — is caught by its prose. That clause is deliberately conservative /
fail-closed: over-match a merely-guard-*citing* change to a cheap human approval rather than
miss a guard-*relaxer*. The bare-`.sh` gap is the parallel hole on the enumerated *path* clause,
still open. This decision is **distinct from [#2488](https://github.com/kamp-us/phoenix/issues/2488)**,
which is about the *scan-coverage* of what `validate-gate-path-drift.sh` inspects (the `HAS_*_RE`
class-regex copies); #2525 is about how the guard's *own file* is classified. Reference, do not
conflate.

The §CP boundary is deliberately **enumerated**, not "everything gate-critical," so whether
these guards belong inside it is a genuine control-plane / founder call (ADR
[0053](0053-control-plane-boundary.md)), which is why this is a decision, not a mechanical patch.
Competing mechanisms:

1. **Broaden the regex** — add an alternative `^claude-plugins/kampus-pipeline/skills/[^/]+\.sh$`
   so any bare `.sh` directly under `skills/` is §CP. Self-covering by pattern and future-proof
   (no list to maintain); widens §CP to *any* future bare script under `skills/`.
2. **Enumerate** the four specific guards into `CONTROL_PLANE_RE`. Precise, but a hand-maintained
   list that drifts as guards are added/removed — the exact drift class §CP single-sourcing exists
   to kill (ADR [0073](0073-review-skill-gate.md) §6).
3. **Relocate** the guards into a recognized gate subdir so the existing subdir alternative
   already covers them. No regex change, but moves files the verbatim copies / symlinks reference
   (each guard is self-locating and CI invokes it by path), so it ripples across consumers.
4. **Accept the risk** and document why (rely on the guard self-referentially or another guard).

## Decision

**PROPOSED — awaiting founder ruling. This ADR records the choice and a recommendation; it does
not enact it.**

**Recommended: option 1 — broaden `CONTROL_PLANE_RE`** with an alternative matching any bare
`.sh` immediately under the pipeline `skills/` root:

```
^claude-plugins/kampus-pipeline/skills/[^/]+\.sh$
```

Rationale, grounded in the existing §CP design:

- **Fail-closed by construction, no drifting list.** Every current *and future* bare gate script
  auto-classifies §CP without an enumerated list to maintain — avoiding the mechanism-2 drift
  class that ADR [0073](0073-review-skill-gate.md) §6 single-sources `CONTROL_PLANE_RE` precisely
  to prevent.
- **Matches the conservatism already ratified for the content axis (ADR
  [0164](0164-guard-relaxing-adr-cp-gate.md)).** Over-matching a non-gate bare script to a cheap
  human approval is harmless; under-matching a gate weakener auto-ships a weakened gate. Same
  fail-closed stance, now on the path axis.
- **The "widens §CP to any future bare script" downside is the safe direction.** Skills are
  authored as `SKILL.md` inside subdirs; there is no legitimate non-gate reason to drop a bare
  executable `.sh` directly under the pipeline skills root, so the pattern's breadth is a feature,
  not overreach.

If founder judgment prefers a narrower surface, mechanism 3 (relocate into a gate subdir) is the
next-best: it needs no regex and reuses the existing subdir alternative, at the cost of moving
files the copies/symlinks reference. Mechanism 2 is discouraged (reintroduces a drift-prone list);
mechanism 4 is rejected (leaves the self-approval-adjacent hole open).

Whichever mechanism is ratified, the decision **covers the whole class** (all four guards above),
and — if inclusion is chosen — the canonical `CONTROL_PLANE_RE` in `gh-issue-intake-formats.md`
and **every verbatim copy** (`ship-it`, `review-code`, `review-skill`, and any other consumer) are
updated together in the same PR, with `validate-gate-path-drift.sh` still passing (the copies stay
in lockstep).

## Consequences

- **Once ratified and implemented (recommended path):** a PR touching any bare gate `.sh` under
  `skills/` classifies §CP at `ship-it` Step 0 and requires a `@kamp-us/control-plane` approval
  before enqueue (ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)) —
  the self-approval-adjacent hole closes, and the guard surface becomes self-covering.
- **Cost:** the `CONTROL_PLANE_RE` edit is itself a §CP change and lands through the human gate;
  all verbatim copies move together under `validate-gate-path-drift.sh`'s lockstep. Any future
  bare `.sh` added under `skills/` inherits §CP membership automatically — intended.
- **Until ratified, the hole stands.** This ADR does not change classification; it records the
  decision for founder ruling. Implementation is a separate follow-up PR (the code change is
  small once the boundary is decided).
- **Bounded blast radius vs #2488.** This settles the guard's *own classification* only; the
  guard's *scan-coverage* (#2488) remains a separate concern and is not addressed here.
