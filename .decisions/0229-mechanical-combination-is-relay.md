---
id: 0229
title: Combining verb answers stays relay only while the combination is mechanical
status: accepted
date: 2026-07-30
tags: [pipeline, skills, control-plane, tooling]
---

# 0229 — Combining verb answers stays relay only while the combination is mechanical

**What this decides:** ADR [0228](0228-scripts-relay-never-derive.md) ruled that an extracted skill
script may relay a `pipeline-cli` verb's decision but never derive one, and left one case open: a
script that reads *two* verbs and combines their answers. This settles it — combining is still
relaying as long as the combination is **total, mechanical, and passes UNKNOWN through as a
refusal**; the moment it adds a threshold, a precedence, a tie-break, or a regex that reinterprets a
verb's output, the script has derived a decision and that logic belongs in a verb.

## Context

ADR [0228](0228-scripts-relay-never-derive.md) was written before a single script existed. It said
so: confidence 8/10, "sound against the plan and the ordering ruling but untested against real
code," with the first extraction child (#4448) named as the falsification site and an explicit
instruction to amend rather than defend if the test failed to discriminate there. It also named one
case it deliberately did not resolve — *"a script that reads **two** verbs' outputs and combines
them into a conclusion neither verb reached is arguably deriving."*

Since then phase 1 of epic #4435 has largely landed: `claude-plugins/` went from roughly a dozen
shell files to **208** (measured 2026-07-30 at this ADR's merge base; the figure keeps moving),
extracted across the epic's children over a handful of merged PRs. The test now has a corpus. Two
findings from reading it:

**The test discriminates.** `skills/ship-it/scripts/step2-verdict-gate.sh`
is an unambiguous relay: it calls `class-probe classify --namespaces`, checks that call's status,
refuses when it refuses, refuses again when it names zero namespaces, and hands the result to
`verdict gate`. Every decision-bearing branch consults a verb; the script routes.
`skills/ship-it/scripts/step0-classify.sh`
is the opposite pole and is *correctly* named by 0228: it `grep`s the changed-file list in shell to
derive the §CP answer — boundary-regex matching, explicitly on 0228's banned list. That residue is
not a violation today; phase 1 was ruled a mechanical byte-move, and #1929 owns retiring it. The
value of the test is precisely that it labels that file's glue without anyone having to argue.

**The open case is not hypothetical — it is the shape of the good example.** `step2-verdict-gate.sh`
reads one verb, transforms its output, and feeds a second. Under a strict reading of "a conclusion
neither verb reached," that is combination. Under any useful reading it is obviously relay. Leaving
that unruled means every phase-2 (#1929) migration re-argues it. This ADR draws the line where
those two readings part.

The failure this line exists to prevent has a live, filed instance: **the same question answered
twice, drifting** (#4509 — content-scoped guards whose asserted population silently shrank when
extraction relocated the content they scoped on). That is what "derive" costs when it is allowed:
not one wrong answer, but two authorities that can disagree with nothing to force the disagreement
into the open.

**This ADR amends 0228 in part.** It fills the case 0228 marked open — and in doing so it makes one
of 0228's own binding constraints false (*"the two-verbs-combined edge is unresolved; do not treat
this ADR as ruling it either way"*) and sharpens `derive-vs-relay`, the term 0228 coined. So the
cross-link goes both ways: 0228's **status line** carries `amended-in-part by [0229]`, its body
untouched (ADR immutability), and this ADR is where the qualifier lives. A reader arriving at 0228
alone must not walk away with the unqualified definition. Beyond that, this ADR adds the
same-question test, and records the enforcement question as **deferred** rather than ruling it.

## Decision

**A script that combines two verbs' answers is still relaying when the combination is total,
mechanical, and UNKNOWN-propagating; it is deriving the moment the combination introduces a
judgement no verb made.**

Three properties, all readable off one script, all falsifiable without knowing the domain:

1. **Total** — every answer the verbs can produce has a defined outcome in the script, *including
   their refusals*. A combination with an unhandled input is not mechanical; it has a silent
   default, and a silent default is a judgement.
2. **Mechanical** — the combination introduces no value that was not already in a verb's answer.
   Reformatting, joining, counting, passing one verb's output as another's argument: mechanical. A
   threshold ("more than 3 ⇒ block"), a precedence order between two verbs that disagree, a
   tie-break, or a regex over a verb's stdout that *reinterprets* it into a different category:
   judgement — that is a verb.
3. **UNKNOWN-propagating** — a verb's refusal leaves the script as a refusal. A script that turns a
   verb's non-zero exit into an empty set, a zero count, or a clean pass has derived the decision
   "the answer is nothing," and no verb decided that. This is the single most-repeated defect in
   this corpus (#4010, #4216, #4231 are all this shape) and the reason ADR
   [0092](0092-gates-fail-closed-on-zero-scope.md) exists.

**The mechanical floor for (3), stated so a script author cannot get it half-right.** Every refusal
path must exit **non-zero AND print a non-empty line**. Non-zero with silent stdout is fail-open
here, not fail-closed: most of these scripts are sourced into an agent's shell, and an agent
reading a status with no message has nothing to report and no reason to stop. Relatedly, on bash 3.2 a `set
-u` abort that reaches an `EXIT` trap exits **0** — a fail-closed script exiting clean having
printed its FAIL (#4476).

**Executed** extracted scripts therefore use `set -uo pipefail` and install no `EXIT` trap. The
scoping to *executed* is load-bearing, not a hedge: a script **sourced into the agent's shell** sets
options in *that* shell, so a sourced script may deliberately set none — and the corpus does exactly
this. Of the 208 `.sh` files under `claude-plugins/`, 61 set no options at all, and 60 of those 61
say why in their own headers. Two of them matter here:
`step2-verdict-gate.sh`,
this ADR's relay exemplar above, records that several of its guards depend on `pipefail` being
**off**; `shared/scripts/cp-guard-adr.sh`
records the same. Stated universally the constraint would condemn its own good example, so it is
stated with its scope.

Enforcement of the two halves lives in **two different places**, and neither is a general
`set -uo pipefail` check.
`trap-status-guard` (retired with v1, #5937)
reds on exactly one banned co-occurrence — `errexit` enabled together with an `EXIT` trap inside one
runnable unit; `set -uo pipefail` *with* a cleanup trap is measured fail-closed and therefore
permitted ([`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md)'s
matrix). The no-`EXIT`-trap norm for extracted scripts is enforced by
`verify-extraction.sh`
check 6. Both are the fail-closed-on-zero-scope shape of ADR
[0092](0092-gates-fail-closed-on-zero-scope.md).

**The same-question test — when two implementations are duplication and when they are not.** "Two
implementations of the same logic" is the derive violation restated, so it needs a check that is not
a matter of taste. Write each implementation as *input domain → answer*. They answer the **same**
question if there exists an input both accept on which they could disagree; then one must call the
other, or one must go — *unless* the second derivation is a deliberate, **recorded second
derivation** whose every divergence path is proven to fail safe (the ADR
[0225](0225-verdict-bodies-carry-no-cp-classification.md) shape: `ship-it` re-derives §CP rather
than reading a reviewer's answer, and all six divergence paths were traced to a bank or a stall).
If the input domains do not overlap, they answer **different** questions and two implementations are
correct, no proof needed.

Two precisions on that hatch, because it borrows 0225's authority. It is a *second* derivation, not
an *independent* one: 0225 §1 denies independence in terms — "two invocations of one recipe … not
two implementations" — and its reversal condition reserves "a genuinely independent second
derivation" for a **future** state that would make its argument lapse. And 0225's *deciding* reason
was cost plus near-zero detection power; the six-path fail-safe trace was the enabling condition,
not the ratio. What this hatch licenses is therefore the trace, not the duplication.

The worked boundary case, already ruled by a review gate:
[`packages/pipeline-cli/src/skill-shell-surface.ts`](../packages/pipeline-cli/src/skill-shell-surface.ts)
takes a markdown heading slice and returns that section's shell surface *as text*, appending the
content of each script the slice sources; `kp_skill_shell_surfaces` in
`lib/common.sh`
takes a skill directory and returns its *file paths*, sorted. No input is accepted by both, so
neither can contradict the other — different questions, not duplication. The same file carries the
positive case: `sourcedScriptNames` is deliberately the *same* matcher `adoption-lint`'s claim pins
use, because "which script does this text source?" **is** one question, and three consumers
answering it three ways would be its own defect.

**The enforcement question (#4447's third criterion): DEFERRED, follow-up filed as #4527.** This ADR
does **not** rule guard-vs-norm for keeping new decision-deriving shell out of skill markdown, in
either direction. The founder ruling on #4447 held that question open deliberately: a new guard is a
guard-reshaping act, and the standing practice — ruled on #4505 the same night — is that guard
changes get an **adversarial threat-model review**, not a ride-along in a decision record. #4527
owns the question and is where it gets answered.

What this ADR contributes to that review is **input, not a finding**: a guard whose subject
population is "fenced shell in `SKILL.md`" has no honest population to scope on, because the
sanctioned *invocation* is itself a fenced shell block — so such a guard needs an arbitrary size or
content threshold and would assert far less than its name implies, which is the #4509 shape. Whether
that objection is fatal, or answerable by a differently-scoped guard the threat model surfaces, is
#4527's call and not this ADR's.

Until #4527 lands, the **operative state** — the status quo, not a ruling that the status quo is the
end state — is the norm plus the existing review gates for the judgement half, and the existing
mechanical guards (`trap-status-guard`, `cli-invocation-guard`, `skill-gh-lint`) for the parts that
*are* mechanically checkable. Evidence of re-embedding at scale after phase 2 is input to #4527 too.

**Binding constraints.**
- A combination of verb answers is relay only if it is total, mechanical, and UNKNOWN-propagating;
  failing any one of the three makes it a derive, and that logic becomes a verb by end of #1929.
- Every refusal path in an extracted script exits non-zero **and** prints a non-empty line.
- **Executed** extracted scripts set `set -uo pipefail` and install no `EXIT` trap. A script sourced
  into the agent's shell is out of this constraint's scope and may deliberately set no options.
- Before adding a second implementation of anything, state both as input → answer; if they share an
  input they answer one question — collapse it, or carry a recorded 0225-shape fail-safe proof.

**Banned.**
- A combination that introduces a threshold, a precedence between disagreeing verbs, a tie-break, or
  a regex that reinterprets a verb's output into a different category.
- Turning a verb's refusal into an empty set, a zero count, or a pass.

## Consequences

- Phase 2 (#1929) migrations apply a three-property check per script instead of re-litigating
  0228's open case at each one.
- The check is cheap and local: it needs one script and no domain knowledge, which is what makes it
  usable at one control-plane approval per round.
- It is deliberately permissive at the mechanical end. A script may sequence, join, count and pipe
  verb answers freely; that keeps phase 1's byte-moves legal and stops the test from swallowing the
  whole corpus into verbs, which is the trap 0228 already rejected the candidate test for.
- It buys nothing against a *wrong verb*. The test says who decided, never whether the decision was
  right — the gates remain the check on correctness.
- Enforcement stays open until #4527 rules it, so a real residual stands in the meantime: nothing
  mechanically stops new glue landing in skill markdown. That residual is the cost of routing a
  guard change through a threat-model review instead of deciding it here.

## Records

- Records two of the remaining rulings on #4447 — the combination case and the same-question test.
  The third, enforcement shape, is recorded as **deferred to #4527**, not ruled.
- **Amends ADR [0228](0228-scripts-relay-never-derive.md) in part**: closes its enumerated
  "two-verbs-combined edge is unresolved" constraint and qualifies the term it coined. 0228's status
  line carries the forward pointer.
- Vocabulary impact: **redefines `derive-vs-relay`** (coined by ADR
  [0228](0228-scripts-relay-never-derive.md)) by adding the three-property combination qualifier.
  0228's routing of that term to [`.glossary/TERMS.md`](../.glossary/TERMS.md) never landed; the
  sharpened row is routed by #4525, since this PR touches only `.decisions/`.
