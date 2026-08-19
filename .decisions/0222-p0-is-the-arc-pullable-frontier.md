---
id: 0222
title: p0 is the arc's pullable frontier — required and unblocked, both (amends 0202 §1)
status: accepted
date: 2026-07-26
tags: [process, prioritization, triage, pipeline]
---

# 0222 — p0 is the arc's pullable frontier — required and unblocked, both (amends 0202 §1)

**What this decides:** `p0` now takes two tests instead of one. Work only earns it if the arc genuinely cannot be called done without it *and* nothing else has to land first. Being inside the active arc is no longer enough. Fires are untouched and keep their existing `p0` path.

## Context

Founder ruling, 2026-07-26, recorded on the conversation-authored path (ADR [0075](0075-issueless-doc-pr-merge-seam.md)).

Amends in part [0202](0202-forward-motion-doctrine-crewops.md) — §1's `p0` semantics only. This **narrows 0202's own recorded language.** That ADR ruled `p0` is "freely minted for moves-us-forward work," and the triage rubric it produced (`claude-plugins/kampus-pipeline/skills/triage/SKILL.md`, the Step-6 priority table) says exactly that: mint `p0` **freely**, and *"the one hard bound is homing."* Homing is today the **only** bound on `p0`. This ADR adds two more. It is a change to the doctrine, not a clarification of it, and is recorded as one.

**The measured divergence.** Three epics graduated from one wayfinder map (#4261), all homed in the same active arc (Geçit, milestone #24), triaged within minutes of each other by three independent passes — and came out in two different bands:

| issue | band | the pass's recorded reasoning | test it was reaching for |
|---|---|---|---|
| #4304 | `p0` | the arc's named gap, verbatim; arrival gates the whole funnel | required + pullable |
| #4306 | `p1` | "an unplanned, unpitched umbrella that no engine can pull" | **not pullable** |
| #4307 | `p1` | "half this epic ships dark behind a flag flip owned elsewhere" | **blocked** |

**The ruling ratifies what the triagers already did — all three bands stay unchanged.** That is the argument for it. #4306 and #4307 were already frontier reasoning: both declines name pullability, neither could cite a rule licensing the decline, so both hedged down to `p1` — and #4304's pass, reading the same rubric text literally, correctly got `p0` under it. #4304's note even flags its own doubt in writing ("the honest alternative is `p1` — if the band should distinguish 'the arc's centre' from 'in the arc,' re-band cheaply"). Three good-faith passes, one rubric, an instinct the rubric could not express. This ADR overturns nothing; it makes that instinct repeatable rather than a matter of who happens to be triaging.

**Why a frontier rather than "the single most central thing."** Exactly-one breaks the moment two items genuinely both block an arc, forcing a triager to invent a tiebreak the rubric does not supply. "A small core set" is taste with extra words — two triagers will diverge on *core* exactly as these diverged on *centre*. Necessity and unblockedness are both checkable against written artifacts; centrality is not.

**This is not ADR [0219](0219-priority-decoupled-from-campaign-membership.md)'s territory.** All three bands above derive from the **active arc**, not campaign membership, so 0219 — accepted, and cited by every one of the three triage notes as not binding on an arc-derived call — leaves this fork untouched. 0219 removed a roadmap row as an *input* to the band; this ADR defines what the `p0` band *means*. Two independent gaps in the same rubric.

## Decision

**`p0` requires two properties, both true: the arc cannot be called done without the work, and nothing else has to land first — `p0` is the arc's currently-pullable critical path, not a ranking and not a fixed-size tier.**

1. **Necessary.** The arc cannot be called done without it — necessary to the arc's *stated goal*, not merely homed in the arc. Membership in the arc is not the test; it never was sufficient and is now explicitly not.
2. **Unblocked.** Nothing else has to land first. It is pullable right now: an engine could pick it up today and finish it without waiting on another issue, another owner's flip, or an unwritten plan.

**The count is not the rule; the property is.** Multiple simultaneous `p0`s are normal and expected — the set is however many items are required *and* unblocked at once. As each lands, whatever it was blocking becomes unblocked and is promoted. `p0` is therefore a **frontier**: a set that shrinks and refills as an arc drains. Do not read this as a cap, a ranking, or a quota. A large `p0` set on a wide-open arc is correct; so is a `p0` set of one on an arc down to its last dependency chain.

Work that is necessary but blocked is `p1` (it is what you would pull next, the moment it clears). Work that is unblocked but not necessary to the arc's goal is priced on its own merit under the existing bands.

**Fires are untouched.** Actively breaking something people rely on, a data-loss or security risk, a blocked release gate — these keep their existing `p0` path and take neither test. A fire is not arc work and is not argued against an arc's goal.

**Binding constraints.**

- `p0` requires **both** properties — necessary to the arc's stated goal, **and** unblocked right now. One without the other is not `p0`.
- Arc membership alone never earns `p0`.
- Blocked work is not `p0`, however necessary — it is promoted when its blocker lands, not before.
- Fires keep their existing `p0` path, exempt from both tests.
- Homing is unchanged: an orphan `p0` remains invalid (ADR [0202](0202-forward-motion-doctrine-crewops.md) §2, as amended by ADR [0219](0219-priority-decoupled-from-campaign-membership.md) — any milestone, or a standing lane under ADR [0208](0208-standing-lane-exemption-from-full-homing.md), satisfies it).

**Banned.**

- Minting `p0` for arc-homed work that the arc's stated goal does not require.
- Minting `p0` for work that cannot be pulled today.
- Reading `p0` as a fixed-size tier, a top-N ranking, or a cap on how many items may hold it.

**Open question, deliberately unresolved.** The necessity test still admits argument at the margin — a determined triager can claim any arc issue is necessary. A tighter form was offered and not taken either way: *"the arc's stated goal is not met without this,"* which forces the argument back to the arc's **written** definition rather than a triager's opinion. It is recorded here as open, not adopted and not dropped; it should be decided deliberately rather than discovered at the next divergence.

## Consequences

- **Owed work: the rubric text at `claude-plugins/kampus-pipeline/skills/triage/SKILL.md`.** The Step-6 `p0` row still teaches "mint `p0` **freely** … the one hard bound is homing," which this ADR narrows. Until it is rewritten, agents will keep reproducing the divergence. This ADR does not do that edit.
- **That edit must not be folded into the in-flight `p1`-from-campaign-membership rubric alignment (#4284 / PR #4293).** Same file, different defect: #4284 is mechanical reconciliation of already-decided text to ADR 0219, this is a doctrine change. A combined PR would make the doctrine change invisible inside a mechanical edit, and would give reviewers no seam at which to argue it. Separate PRs.
- The triage skill is control-plane, so that edit banks for control-plane approval at head like any other §CP change.
- **`p0` becomes a working queue, not a label.** Engines filling `p0` first now fill from a set that is by construction pullable — a `p0` an engine cannot start is now a triage defect, not an ordinary state of the board.
- **Promotion becomes a real, recurring triage action.** When an item lands, whatever it unblocked has to be re-banded. Nothing automates this today; a stale `p1` that has quietly become the frontier is the new drift mode, replacing the old one (arc-homed work inflating `p0` by membership).
- **Fewer `p0`s on a young arc, more on a draining one.** The population inverts relative to the old rule: an arc whose work is mostly downstream of one unlanded dependency correctly shows a narrow `p0`, where "freely for arc work" showed a wide one.
- **Existing labels are not invalidated.** No mass repricing is owed — the motivating case is already correct under this rule.
- **The generalizable lesson.** Three independent passes reached for the same unwritten test and two of them hedged because they could not cite it. A rubric that forces good judgment to argue *around* it, rather than *from* it, is under-specified — and the repeated hedge, not the outlier, is the signal.

## Records

- **Vocabulary impact: coins `p0` frontier** — the currently-pullable critical path of an arc: the set of work that is both required by the arc's stated goal and unblocked right now, which shrinks and refills as the arc drains (as against a ranking or a fixed-size tier). Routed to `.glossary/TERMS.md` via a `report` issue for the glossary skill to pick up; it needs the "not a ranking / not a cap" disambiguation the glossary treatment gives it, not a bare row.
- Amends in part [0202](0202-forward-motion-doctrine-crewops.md) (§1's `p0` semantics only — §2's no-orphan rule and points 3–5 stand, as does §2's amendment by [0219](0219-priority-decoupled-from-campaign-membership.md)).
- Leaves [0219](0219-priority-decoupled-from-campaign-membership.md) untouched: campaign membership is not an input here, and this ADR is not an argument about roadmap rows.
- Contradiction sweep: [0208](0208-standing-lane-exemption-from-full-homing.md) and [0210](0210-direction-binds-at-intake.md) are adjacent but not in conflict — 0208 rules on *where* work may be homed (unchanged here, and cited in the binding constraints), and 0210 rules on per-cycle *lane allocation*, which consumes a band rather than assigning one. Both continue to bind on top of the bands this ADR produces. Also consistent with [0072](0072-milestones-encode-strategic-sequencing.md)'s "p0 stays sovereign" and [0078](0078-product-driven-decisions-by-default.md) (product-driven by default); neither is re-decided.
- Evidence issues: #4304 (`p0`), #4306 (`p1`), #4307 (`p1`); wayfinder map #4261. Owed rubric edit is distinct from #4284 / PR #4293.

> Amendment 2026-08-19: `claude-plugins/kampus-pipeline/skills/triage/SKILL.md` is gone with the v1 plugin retirement (ADR 0303). The live rubric is `claude-plugins/fabrika/skills/triage/SKILL.md` (step 7, "Price it"), and the "mint `p0` freely … the one hard bound is homing" text no longer exists there — the owed rubric edit is moot. The two tests below still bind on that step.
