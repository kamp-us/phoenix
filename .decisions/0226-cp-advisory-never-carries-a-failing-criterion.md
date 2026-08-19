---
id: 0226
title: A §CP advisory may never carry a failing criterion — emit FAIL instead
status: accepted
date: 2026-07-27
tags: [pipeline, control-plane, review-gates]
---

# 0226 — A §CP advisory may never carry a failing criterion — emit FAIL instead

**What this decides:** When a review gate finds a failing criterion on a control-plane PR, it posts a normal FAIL verdict (which sends the author into a repair round), instead of posting the "advisory" verdict that control-plane PRs otherwise get — because an advisory that carries a failure is a state nothing downstream knows how to act on.

## Context

On a §CP PR, a reviewer advisory bound to the current head whose body carries a `[FAIL]` criterion
is a state the pipeline already produces and already refuses. On the merge target, the §CP arm of
`decideNamespace` in `packages/pipeline-cli/src/tools/verdict/gate-decision.ts` tests the advisory
body against `failCheckboxRe` (line 46) and returns `state: "unverified"` with the reason
`unverified (§CP <namespace> advisory not all-PASS — a body checkbox is [FAIL])` (lines 176–184).
Two consequences follow, both deliberate:

- **Not shippable.** `decideGate`, in the same file, blocks on the first namespace whose state is
  not `pass` (line 275), so `enqueueable: false`.
- **Not pickable for repair.** `unverified` is neither `pass` nor `fail`, and a repair scan keys on
  a namespace's *polarity* (`verdict read --expect FAIL`). A state that carries no polarity can
  never match one, so the PR is never routed into the author's repair round.

The design names a **re-review** as that state's remedy, and nothing in the repo arms one: no skill
step, no crew agent branch, no CI workflow, no CLI verb fires a re-review off the state. A §CP PR
that reaches it waits until a human notices it waiting.

**Naming — read this before the ruling below.** A read-side refactor was in flight when this was
ruled: PR #4372, open and unmerged at the time of writing. At **that PR's head, and only there**,
this state has a name of its own — an `advisory-not-all-pass` variant of `VerdictOutcome` in
`packages/pipeline-cli/src/tools/verdict/verdict-match.ts`, a `verdictState` helper projecting it
(with the SHA-less and stale outcomes) onto `"unverified"`, and a docblock spelling out that the
variant is deliberately not a FAIL. **None of those symbols exist on the merge target**, where the
state is produced inline by the `gate-decision.ts` branch cited above and carries no name at all.
The rest of this ADR refers to the state by the in-flight name, because that is the vocabulary the
ruling was made in; if that refactor never lands, read every such mention as the inline branch cited
here. The ruling is about which side *emits* the state, so it holds under either spelling. Source
issue #4400 carried this same qualifier and it belongs in the durable record.

One question was open, with two mutually exclusive answers: **which side owns the signal.**
*Emit-side* — make an advisory structurally unable to carry a failing criterion, so the state cannot
arise. *Consumer-side* — accept the combination as legitimate and build a surface that arms the
re-review the design already names. Triage recorded both and ranked neither; a founder ruling picked
emit-side.

The gates that emit the canonical §CP advisory form are `review-code`, `review-doc`,
`review-design` and `review-skill`, each under its own *"Pass path — blocking-set PR (advisory
only…)"* section (`review-code` and `review-skill` extend that heading with *", the canonical
advisory form"*), against the one shared advisory shape in §6.6 of
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`. That convergence on a single
advisory shape is ADR [0073](0073-review-skill-gate.md) §5; the form itself is ADR
[0111](0111-blocking-set-verdicts-sha-less-by-design.md) (SHA-less first line, so it never enters
`ship-it`'s auto-merge PASS namespace), with its body-anchored reviewed head from ADR
[0151](0151-cp-advisory-body-sha-resolves-approval-aware-enqueue.md). The §CP set itself is ADR
[0053](0053-control-plane-boundary.md), hard-gated by ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) and extended by content
to guard-touching ADRs by ADR [0164](0164-guard-relaxing-adr-cp-gate.md). Verdict markers are ADR
[0058](0058-sha-bound-verdict-contract.md). This ADR rules on *what an advisory may contain*, not on
its shape, its namespace, or its authorization semantics — none of those change.

## Decision

**A review gate may not emit a §CP advisory whose body carries a `[FAIL]` criterion; on a failing
criterion it emits its FAIL marker instead, which routes the PR into the author's repair round.**

The `advisory-not-all-pass` state stops being **produced**. The consumer-side branch — accepting the
combination and building a surface that arms the re-review — is **rejected**, on three grounds.

1. **The advisory form exists to withhold merge authorization, not to soften a failure.** Under ADR
   [0111](0111-blocking-set-verdicts-sha-less-by-design.md) a §CP verdict is advisory precisely so it
   cannot authorize a merge. That is a statement about the **PASS** side: it takes a verdict that
   would otherwise be merge-authorizing and strips the authorization, deferring it to the
   control-plane approval. Stretching the same form to carry a genuine failing criterion invents a
   middle register the pipeline has no way to act on.
2. **A real failure already has a working, armed remedy.** A `[FAIL]` criterion means something is
   wrong with the change. Its remedy is the author's repair round followed by a re-review — a loop
   that exists and is armed today. The consumer-side branch would build **new dispatch machinery**,
   in the control plane, to rescue a state that should never have been produced: new surface, inside
   a milestone whose whole purpose is to reduce surface.
3. **It matches recorded precedent (#3492): fix emit-side, never carve out the consumer.**

**This does NOT re-map `advisory-not-all-pass` to `fail`.** The variant and its `verdictState` →
`"unverified"` projection stay **exactly** as documented in the `verdict-match.ts` variant docblock —
*"Deliberately NOT a FAIL: an advisory carries no polarity, and its remedy is a re-review, not the
author repair round-trip."* Nothing about the mapping, the projection, or the reason string changes.
The state becomes **unreachable**, not reclassified: no emitter produces it any more, so no consumer
has to interpret it. An implementer who reaches for the `fail` mapping under this ruling has mis-read
both the ticket and the ruling — the mapping is out of scope here and stays intact.

**What a gate emits instead.** On a §CP PR where one or more criteria fail, the gate takes its
**fail path**, not the advisory path: the SHA-bound `<gate>: FAIL @ <sha> — not merge-ready` marker
in its own namespace (ADR [0058](0058-sha-bound-verdict-contract.md)), with the full criterion table
and evidence. That marker is the seam the author's repair round keys on, so the PR routes to
repair → re-review, the loop that is already armed. The advisory form is reserved for what its own
section already calls it: a **pass** path — every criterion passed, and only the merge authorization
is withheld pending the control-plane approval at head (ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)).

**The concrete emit-side surface that changes** is the four review gate templates and the shared
advisory shape they converge on:

- `claude-plugins/kampus-pipeline/skills/review-code/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-doc/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-design/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-skill/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` — the one canonical advisory form

Each must make the precondition explicit and unmissable at the point of emission: **all criteria pass
→ advisory; any criterion fails → FAIL marker**, with the §CP branch evaluated *after* the criterion
verdict, never before it.

**Fail-closed is preserved end to end.** A non-`pass` namespace still yields `enqueueable: false`;
`decideGate` is untouched. Nothing here makes anything mergeable that was not mergeable before. The
direction of the defect was always a **stall**, never an unsafe merge, and the outcome of this ruling
is a **shorter stall** — the PR lands in a state that already has an armed exit instead of one that
waits for a human to notice. This must not be read as a third phantom control-plane alarm.

**Binding constraints.**
- A §CP advisory body carries `[PASS]` criteria only.
- A failing criterion on a §CP PR emits the gate's FAIL marker, routing to the repair round.
- The §CP branch is evaluated after the criterion verdict, never instead of it.
- `verdictState`'s `advisory-not-all-pass` → `"unverified"` projection is untouched.

**Banned.**
- Re-mapping `advisory-not-all-pass` to `fail`.
- New consumer-side dispatch machinery to arm a re-review off the state.
- Any change that lets a non-`pass` namespace reach `enqueueable: true`.

## Consequences

Easier: a §CP PR with a real defect now enters the same repair loop as any other PR, with no new
machinery and no new control-plane surface. The `advisory-not-all-pass` variant survives as a
**fail-closed backstop** for a hand-written or freelanced advisory that violates this rule — it stays
in the code, still refusing to enqueue, and its reachability becomes the signal that some emitter
drifted.

Harder: the emit-side precondition lives in four gate templates plus the shared form, so it is a
five-surface edit and a drift risk if one gate is missed. The mitigation is that all five already
converge on one canonical advisory shape (ADR [0073](0073-review-skill-gate.md)), and that the
surviving variant fails closed if a gate does drift.

**The FAIL marker's tail is per-gate — do not propagate the one written above.** `## Decision`
writes the marker generically with `review-code`'s tail (`— not merge-ready`, §5 of the shared
format doc); `review-doc` (§6), `review-skill` (§6.5) and `review-design` (§6.7) each use
`— changes-requested`. Since this ruling names five files to be edited by hand, the implementer
keeps **each gate's own existing tail** and changes only which path is taken. Nothing here alters
any marker's shape: no matcher under `packages/pipeline-cli/src/tools/verdict/` reads the tail at
all — ADR [0058](0058-sha-bound-verdict-contract.md) binds the namespace, the polarity and the SHA,
and the tail is prose for a human reader.

**Scope fences, recorded and not crossed:**

- **PR #4372 is not widened by this.** The engine holding it declined to widen it deliberately —
  it is a `p0` with clean gate rounds and a §CP approval cost per head move, and this is a distinct
  decision about which side owns the signal. That decline is recorded as **considered, not an
  omission.** It is also why the naming note in `## Context` exists: the vocabulary this ruling uses
  lands with that PR, not with this one.
- **#4105** (read-side observability) and **#4390** (repair-mode entry condition) are **not
  absorbed.** They are adjacent seams on the same machinery and remain separately open; this ruling
  covers the **dispatch** seam only — which side owns the `advisory-not-all-pass` signal.
- **Build work is filed separately, after this ADR.** No code lands under the issue this ADR rules
  on; the implementation lands as its own work with its own §CP round.

## Records

- Rules #4400 (`type:decision`) — the dispatch seam of the §CP verdict-integrity campaign.
- **No vocabulary impact.** This ADR coins and redefines nothing: `advisory`, `§CP`, the FAIL marker
  and the `advisory-not-all-pass` variant are all already-named concepts, and the ruling re-decides
  which side emits, not what anything is called. Considered and explicitly none.

> Amendment 2026-08-19: the four `claude-plugins/kampus-pipeline/skills/review-*` gates and `gh-issue-intake-formats.md` retired with the v1 plugin (ADR [0303](0303-retire-kampus-pipeline-plugin.md)). The rule still binds and now lives in one place: fabrika's `review` skill (`claude-plugins/fabrika/skills/review/SKILL.md`), which emits the §CP advisory via `--carrier advisory` and states the advisory is a PASS path only — a failing §CP criterion posts the ordinary FAIL marker. The consumer-side backstop named below is gone: `packages/pipeline-cli/src/tools/verdict/` was deleted with that package (PR #6326), so the `advisory-not-all-pass` → `"unverified"` projection has no implementation at head and the producer-side rule is the whole guard.
