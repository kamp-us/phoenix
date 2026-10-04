---
id: 0472
title: The governance readout is retired, leaving the governance verdict as the fabrika tree's only control
status: accepted
date: 2026-10-04
tags: [fabrika, governance, control-plane, retirement]
---

# 0472 — The governance readout is retired, leaving the governance verdict as the fabrika tree's only control

**What this decides:** fabrika no longer has a periodic summary of landed decisions, and changes to
fabrika's own files keep merging without the founder's approval because the required `governance`
verdict alone holds them.

## Context

[ADR 0274](0274-fabrika-tree-is-not-control-plane.md) kept `claude-plugins/fabrika/**` outside
control-plane and named two things in place of a human approval: a required `governance` verdict on
every fabrika-tree diff, and a "§CP digest readout" that would carry every fabrika-tree landing to the
founder after it merged. The governance and front-door skills also said the founder had retired the
human gate on decision records on the condition of that periodic digest. No decision record stated
that condition; it lived only in skill and contract text.

The readout was built (`fabrika governance digest`, `fabrika governance readout`,
`fabrika status readout`, `fabrika status bootstrap readout-artifact` and the `governance-digest`
wire format) and never ran. No workflow, schedule or skill step called it. Its fixed issue,
[#5616](https://github.com/kamp-us/phoenix/issues/5616), held no digest in about 50 days, and because
the bootstrap created it with no labels it sat in the triage queue forever and was reported late in
every `fabrika table digest` post ([#10529](https://github.com/kamp-us/phoenix/issues/10529)).

Two founder rulings on #10529 settle it:

- 2026-10-04, [retire it](https://github.com/kamp-us/phoenix/issues/10529#issuecomment-5984818746):
  *"yes please, retire that thing from fabrika, remove everything related to that."*
- 2026-10-04, [the governance verdict alone is enough](https://github.com/kamp-us/phoenix/issues/10529#issuecomment-5985299071):
  asked whether, once the readout is gone, the governance review alone is enough for changes to
  fabrika's own files, the founder answered *"yes, let's do whatever we've been doing for the last 50
  days w/o using that shit :D"*.

This record amends ADR 0274 in part: its non-coverage ruling and its kept §CP paths stand, and its
readout half does not.
It also amends [ADR 0308](0308-bounded-evidence-output-shape.md), whose per-field table classified
`governance digest` and `status readout` as live verbs.

## Decision

**The governance readout is retired with no replacement, and `claude-plugins/fabrika/**` stays
outside control-plane on the required `governance` verdict alone.**

- The verbs `governance digest`, `governance readout` and `status readout`, the `readout-artifact`
  bootstrap surface, the `readout` field of `status open`, the `governance-digest` wire format and
  `governance sweep --landed` (whose only caller was the digest step) are removed from fabrika, with
  every skill, contract and guide sentence that described them.
- The protection substituted for human approval on the fabrika tree is the required `governance`
  verdict, derived from the diff and enforced by `fabrika ship gate` and the `governance-floor`
  check. Nothing after landing replaces the readout. That is the founder's choice: it matches how
  the tree has actually been governed since the readout was built.
- Retiring the human gate on decision records carries no digest condition. Decision records merge on
  the same gates as any other governed-root diff.
- An adopter repo that already ran `status bootstrap readout-artifact` keeps its own open
  "Governance readout" issue. Nothing reads or writes it any more, and the adopter may close it.

**Binding constraints.**
- ADR 0274's other rulings are unchanged: no CODEOWNERS row and no `CONTROL_PLANE_RE` widening for
  `claude-plugins/fabrika/**`, and `.github/**` plus every path the live matcher covers stay §CP.
- Weakening the required `governance` verdict on fabrika-tree diffs without a replacement is
  weakening the only control this tree has.

**Banned.**
- Reintroducing a landed-decision summary as a silent condition in skill text. A new one is a new
  founder decision recorded as a new ADR.

## Consequences

- The triage queue and `fabrika table digest` stop reporting #5616 once it is closed; the lane
  operator closes it after this change merges.
- Nothing built in tells the founder, after the fact, that a fabrika skill changed without him. He
  still sees those changes at the betting table and on the desk. ADR 0274's accepted limit ("visible,
  not impossible") becomes: a gate-weakening fabrika change that gets past the `governance` verdict
  is caught only when someone notices it.
- `status open` prints six fields instead of seven, and `status bootstrap` knows ten surfaces instead
  of eleven.
