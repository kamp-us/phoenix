---
id: 0274
title: "`claude-plugins/fabrika/**` is not §CP — a required governance verdict replaces the human gate"
status: accepted
date: 2026-08-11
tags: [pipeline, fabrika, control-plane, governance, ship]
---

# 0274 — `claude-plugins/fabrika/**` is not §CP — a required governance verdict replaces the human gate

**What this decides:** fabrika's plugin tree does not get a human-approval gate. Instead, a
fabrika-tree change is meant to be held by a machine check (a required `governance` verdict) and then
shown to the founder after it lands (the §CP digest readout). `.github/**` and everything the
existing control-plane matcher already covers stay human-gated, unchanged.

## Context

The question was raised on [#5036](https://github.com/kamp-us/phoenix/issues/5036): fabrika's
gate-critical tree — its `ship`, `governance` and `review` skills — decides what merges, and the
equivalent v1 tree is control-plane (§CP). ADR [0065](0065-gate-critical-skills-are-blocking.md)
established the principle (a gate that can auto-merge a weakening of *itself* is the one catastrophic
case a content review cannot catch) and ADR
[0227](0227-kampus-pipeline-skills-tree-is-control-plane.md) took it to the whole
`claude-plugins/kampus-pipeline/skills/` directory, the directory being the unit so the boundary
cannot rot as skills are added. Both are scoped to the **v1** tree by path; neither says anything
about `claude-plugins/fabrika/**`, and the boundary is path-based (ADR
[0053](0053-control-plane-boundary.md), hard-gated per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)).

Every prior widening of the boundary — ADRs [0100](0100-control-plane-covers-enforcement-guard-packages.md),
[0150](0150-control-plane-covers-pipeline-agent-defs.md),
[0193](0193-lint-governance-config-is-control-plane.md),
[0212](0212-marketplace-manifest-is-control-plane.md),
[0218](0218-pipeline-cli-cp-enforcement-core.md), 0227 — rules on a *different* path set, and 0212
already records that nested `.claude-plugin/` dirs are out because the clause is root-anchored. None
of them rules on `claude-plugins/fabrika/**`, so this ADR supersedes and amends nothing.

**A delegated ruling first said yes, and was reversed.** On 2026-08-10 a founder-delegated ruling on
#5036 (comment `5234572360`) ruled fabrika's gate-critical tree §CP, symmetric with v1: CODEOWNERS
rows plus a `CONTROL_PLANE_RE` widening. Hours later the founder vetoed it in person (comment
`5234614633`), and the veto is the ruling this ADR records. Verbatim: *"now that we have proper eval
handling, i dont want to make fabrika path cp"*, then, presented with the threat model and the two
explicit keeps, *"confirmed"*.

**Why this file exists.** The veto lived only in an issue comment for a day, and in that day a seat
re-discovered the question from scratch and escalated an already-settled decision as unsettled. That
cost an investigation. Writing the ruling here is the fix (founder ruling, #5036 comment
`5247594904`).

## Decision

**`claude-plugins/fabrika/**` does not become control-plane; the protection substituted for human
approval is a required `governance` verdict on fabrika-tree diffs plus a §CP digest readout of every
fabrika-tree landing — visibility after landing replaces blocking before it.**

The ruling has four parts, as ruled:

1. **No §CP coverage for the fabrika tree.** No CODEOWNERS rows are added for it and
   `CONTROL_PLANE_RE` is not widened to cover it. The regex — single-sourced in
   [`packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts`](../packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts)
   and byte-synced into
   [`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`](../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md)
   — anchors its plugin clauses at `^claude-plugins/kampus-pipeline/` (`skills/`, `lib/`, `agents/`,
   `hooks`) and at a root-anchored `^\.claude-plugin/`. Nothing in it reaches
   `claude-plugins/fabrika/`. **That non-coverage is this decision, not an oversight**, and it is not
   to be closed by a hand-widening.
2. **The substituted control is the machine gate plus after-the-fact visibility, not a human click.**
   The `governance` namespace becomes a requirement the diff derives rather than the caller asserts —
   a fabrika-tree diff gates on `governance` whether or not the shipping session asked for it — and
   the §CP digest readout carries every fabrika-tree landing to the founder. The two halves are one
   control: the gate is what holds a change, the readout is what makes a change that got through
   visible.
3. **Unchanged and explicitly kept §CP:** `.github/**` including `.github/CODEOWNERS`, and everything
   the existing matcher already covers. The platform enforces those regardless of anything here.
4. **The accepted limit, recorded so nobody re-derives it as a defect.** The machine chain missed
   self-attesting empty eval assertions on
   [PR #5216](https://github.com/kamp-us/phoenix/pull/5216) — five evals shipped with empty
   `assertions` arrays, caught by `review-skill`, not by the machine chain. So the readout makes a
   gate-weakening landing **visible, not impossible**. The founder accepted that trade knowingly, on
   the strength of the eval + governance machinery.

**Binding constraints.**
- Do not add CODEOWNERS rows for `claude-plugins/fabrika/**`, and do not widen `CONTROL_PLANE_RE` to
  cover it. Reversing this ruling is a new founder decision recorded as a new ADR, not a patch.
- `.github/**` (CODEOWNERS included) and every path the live matcher covers stay §CP.
- A fabrika-tree change's protection is the required `governance` verdict plus the readout. Weakening
  either half without replacing it is weakening the only control this tree has.

**Banned.**
- Recording anywhere that fabrika's tree is simply "unprotected" or "ungoverned". The negation is half
  the ruling; the substitution is the other half.
- Treating the absence of a fabrika CODEOWNERS row as a fail-open to patch by hand.

## Consequences

- fabrika's own gate-critical skills — `ship`, `governance`, `review` — merge with no human approval.
  **What the decision rests on:** the eval + governance machinery, plus the practical fact that these
  PRs are founder-authored today. If fabrika-tree PRs start arriving from authors outside that
  circle, or the eval/governance machinery stops being the thing that catches weakenings, the ground
  this ruling stands on has moved and the ruling should be revisited — deliberately, not by drift.
- The fabrika rebuild wave keeps moving at machine speed; a human click on every skill edit is the
  cost the veto declined to pay.
- Detection moves after the landing. A gate-weakening fabrika change can land and be discovered on the
  readout rather than blocked at the gate. That is the accepted trade, stated as a trade.
- The boundary between the two trees widens: v1's `claude-plugins/kampus-pipeline/skills/` is §CP
  whole (ADR 0227) while its successor's tree is not. This is deliberate asymmetry, and it holds only
  while the substituted control does its job.

## Records

- Records the founder veto on [#5036](https://github.com/kamp-us/phoenix/issues/5036) comment
  `5234614633` (2026-08-10), which reverses the earlier delegated ruling in comment `5234572360` on
  the same issue. Written as an ADR on the founder's instruction, comment `5247594904` (2026-08-11).
- Implementation of the required-`governance` half: [PR #5231](https://github.com/kamp-us/phoenix/pull/5231),
  merged 2026-08-10 — `requiredWithFloor` in
  [`packages/fabrika-cli/src/ship/gate-verb.ts`](../packages/fabrika-cli/src/ship/gate-verb.ts) adds
  `governance` to the required set whenever the diff touches a governance root, and the root list in
  [`packages/fabrika-cli/src/review/classes.ts`](../packages/fabrika-cli/src/review/classes.ts)
  (`.decisions/`, `.claude/`, `.github/`, `claude-plugins/`) covers the fabrika tree by prefix.
- **Enforcement status as of 2026-08-11: the substituted control is not yet machine-binding.** A
  missing `governance` verdict yields a `blocked` answer at exit 0, no workflow under
  `.github/workflows/` invokes `fabrika ship gate`, and the `Governance readout` artifact the digest
  half reads does not exist yet — so today the stop is skill prose, not a gate. This is a gap in
  implementation, not a qualification of the ruling above; it is filed separately through the report
  seam.
- No vocabulary impact: this decides merge authority over already-named concepts (§CP, the
  `governance` verdict, the digest readout), and coins nothing. `governance` already carries its row
  in [`.glossary/TERMS.md`](../.glossary/TERMS.md).
