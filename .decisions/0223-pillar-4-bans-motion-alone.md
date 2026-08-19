---
id: 0223
title: Pillar 4 gains a fifth prohibition — never signal state or meaning by motion alone (amends 0162)
status: accepted
date: 2026-07-27
tags: [design, frontend, accessibility, pipeline]
---

# 0223 — Pillar 4 gains a fifth prohibition — never signal state or meaning by motion alone (amends 0162)

**What this decides:** The accessibility pillar of the design law gets one more "never": a state or a
meaning may not be carried by motion alone. If the only way to tell what a component is doing is to
watch it animate, that is a defect — the state has to be readable when nothing is moving. This is now
law at the point where UI is generated, not only a rule a reviewer applies afterwards.

## Context

Founder ruling, 2026-07-27, recorded on the conversation-authored path (ADR
[0075](0075-issueless-doc-pr-merge-seam.md)). Design law is founder-authored by mandate — ADR
[0078](0078-product-driven-decisions-by-default.md) makes product and design decisions
product-driven and founder-authored by default, and ADR
[0162](0162-four-pillars-design-law.md) states plainly that an agent transcribes these values and
does not invent them.

**Amends in part [0162](0162-four-pillars-design-law.md)** — Pillar 4's prohibition list only.
Everything else in that ADR (the four pillars, the v1 design values, the other three pillars'
prohibitions) stands untouched. 0162 is still `status: proposed` pending its founder prose-and-values
read, so its status line now carries both facts rather than dropping the pending state.

**The upstream ruling.** Issue [#4356](https://github.com/kamp-us/phoenix/issues/4356) — closed as
completed — asked whether a disclosed analogical extension of a design law carries the force of
`LAW` or is merely `CRAFT`. The concrete row under question asserts *"meaning carried by motion —
never motion alone; the state must also be readable when motion is off."* The ruling (comment
`5086908278`) kept it `LAW`, and the reasoning is the load-bearing part: *motion itself should never
mean something, because reduced-motion users are present all the time.*

That is an argument about a **continuously-present user population**. `prefers-reduced-motion` is a
live user setting, not an edge case, so a state legible only while something animates is unreadable
for those users by default. It is explicitly **not** an argument about how tight the analogy to the
colour rule is; the ruling addresses the obligation directly.

**The gap that ruling exposed**, tracked at issue
[#4385](https://github.com/kamp-us/phoenix/issues/4385). Pillar 4 of
[`design-system-manifest.md`](../design-system-manifest.md) carried exactly four prohibitions and no
motion equivalent:

```
- **Never** carry meaning on `--text-faint` (or any token below the 4.5:1 floor).
- **Never** ship an interactive control with no focus ring, and **never** hand-roll a
  per-component `outline` in place of the shared spacer ring (`--focus-ring`).
- **Never** fall below the 36px tap-target minimum hit area.
- **Never** signal state or meaning by color alone.
```

So after the ruling the obligation was `LAW` inside one taste skill while the manifest was silent on
it — and [`CLAUDE.md`](../CLAUDE.md) names that manifest "the CLAUDE.md-for-design — the four-pillars
design law (ADR 0162) as an agent-readable manifest `write-code` reads before generating any UI." An
obligation that lives only in a skill binds only the agents that happen to load it.

**The crux — why this was not already covered.** `prefers-reduced-motion` does appear in the
manifest, but only in the design-sync passage, and only as a **preservation** rule: the repo
primitive owns `prefers-reduced-motion` respect, and "a synced reskin that drops a control's focus
ring, `aria-pressed`, keyboard order, or reduced-motion handling is a regression no matter how good
the new look is." That says *do not lose the handling you have*. The ruled obligation is stronger and
different: meaning must not depend on motion in the first place. **A component can fully respect
`prefers-reduced-motion` and still violate this rule** — by making a state legible only while it
animates, for every user who has motion enabled. The two rules govern different failures, so the
existing passage does not subsume this one.

**The alternative considered and rejected.** Leave the manifest colour-only and enforce the
obligation at review time alone, through the `LAW`-classified row in the taste skill. The argument
for it is real: Pillar 4 works partly *because* it is a tight, memorizable list, and a design law
that accretes entries gets skimmed rather than read. The founder chose to widen — the cost of a
fifth line is smaller than the cost of an obligation that binds only some generating surfaces.

## Decision

**Pillar 4 — Accessibility gains a fifth prohibition: never signal state or meaning by motion
alone.**

The obligation is the exact sibling of the existing colour-alone prohibition, one modality over: a
state or meaning may be *reinforced* by motion, never *carried* by it. The state must remain readable
when motion is off — through text, an icon, a token change, an ARIA state, or any other non-motion
channel.

**Where it binds.** It binds at **generation** time, not only at review time. Before this ruling the
obligation reached only agents that loaded the taste-animation-review skill; after it, it reaches
every UI-generating surface that reads the design manifest.

**Binding constraints.**

- A state or meaning may not be legible only while an element animates.
- Motion may reinforce a state that is already carried by a non-motion channel.
- The obligation holds regardless of whether the user has reduced motion enabled — it is not
  discharged by adding a `prefers-reduced-motion` branch.

**Banned.**

- Reading this ADR as a general principle that a disclosed analogical extension of a design law is
  automatically `LAW`. It is not. The #4356 ruling settled *this* obligation on its own substance;
  classification follows the substance of the obligation, not the fact that an analogy was
  disclosed. A future row that stretches a pillar by analogy has to earn its classification the same
  way.
- Re-opening the `LAW`/`CRAFT` classification settled at #4356.

**Not decided here: the manifest's wording.** This ADR records the decision; it does not transcribe
the prohibition into [`design-system-manifest.md`](../design-system-manifest.md), and that file is
unchanged by this PR. ADR [0162](0162-four-pillars-design-law.md) holds design principles
founder-authored, and ADR [0194](0194-design-law-jsdoc-firewall.md) keeps the normative half of the
design docs off the auto-written path. ADR
[0209](0209-taste-voice-per-aspect-skills.md) states the same routing from the skills' side — taste
skills consult the law and never mint it, and "law changes keep flowing through the existing
ADR-ratify→transcribe path." This ADR is the ratify half of that path; the manifest edit is the
transcribe half, tracked separately at [#4385](https://github.com/kamp-us/phoenix/issues/4385).

## Consequences

- **UI generation is bound earlier.** Every surface that reads the manifest before generating UI
  inherits the obligation, instead of it reaching only reviewers running one taste skill.
- **The taste skill's row can eventually cite the law directly** rather than by analogy, once the
  manifest carries the prohibition. Until then the row stands exactly as it is — its text at
  `taste-animation-review/STANDARDS.md`
  is byte-unchanged by this ADR, as the #4356 ruling requires.
- **Pillar 4's list grows from four entries to five.** That is a real cost against the pillar's
  memorability, accepted knowingly — see the rejected alternative above.
- **Existing UI may not conform.** Nothing in this ADR schedules an audit of already-shipped
  components; the obligation binds new and changed UI from here, and any sweep of existing surfaces
  is separate work.
- **Practice already runs ahead of the law here**, which lowers the migration cost: reduced-motion
  handling is present across the live style and component layer today. What was missing was the
  written rule, not the habit.

## Records

- Amends in part ADR [0162](0162-four-pillars-design-law.md) (Pillar 4 prohibitions only); that
  file's status line is updated and its body is untouched.
- Enacted by [#4385](https://github.com/kamp-us/phoenix/issues/4385), which carries the manifest
  edit. Downstream of the ruling on [#4356](https://github.com/kamp-us/phoenix/issues/4356).
- **No vocabulary impact.** This ADR coins no term and redefines none. "Pillar", "prohibition",
  "design law" and `prefers-reduced-motion` are all already-named concepts; motion-alone signalling
  is the existing colour-alone construction applied one modality over, not a new concept named here.
