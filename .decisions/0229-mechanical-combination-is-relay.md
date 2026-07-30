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
shell files to **169**, extracted across the epic's children over a handful of merged PRs. The test
now has a corpus. Two findings from reading it:

**The test discriminates.** [`skills/ship-it/scripts/step2-verdict-gate.sh`](../claude-plugins/kampus-pipeline/skills/ship-it/scripts/step2-verdict-gate.sh)
is an unambiguous relay: it calls `class-probe classify --namespaces`, checks that call's status,
refuses when it refuses, refuses again when it names zero namespaces, and hands the result to
`verdict gate`. Every decision-bearing branch consults a verb; the script routes.
[`skills/ship-it/scripts/step0-classify.sh`](../claude-plugins/kampus-pipeline/skills/ship-it/scripts/step0-classify.sh)
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

0228 stands unamended. This ADR fills the hole 0228 itself marked, and adds the same-question test
and the enforcement ruling that #4447 asked for.

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
here, not fail-closed: these scripts are sourced into an agent's shell, and an agent reading a
status with no message has nothing to report and no reason to stop. Relatedly, on bash 3.2 a `set
-u` abort that reaches an `EXIT` trap exits **0** — a fail-closed script exiting clean having
printed its FAIL (#4476). Extracted scripts therefore use `set -uo pipefail` with no `EXIT` trap,
and `trap-status-guard` enforces it (ADR [0092](0092-gates-fail-closed-on-zero-scope.md)).

**The same-question test — when two implementations are duplication and when they are not.** "Two
implementations of the same logic" is the derive violation restated, so it needs a check that is not
a matter of taste. Write each implementation as *input domain → answer*. They answer the **same**
question if there exists an input both accept on which they could disagree; then one must call the
other, or one must go — *unless* the second derivation is a deliberate, recorded independent
re-derivation whose every divergence path is proven to fail safe (the ADR
[0225](0225-verdict-bodies-carry-no-cp-classification.md) shape: `ship-it` re-derives §CP rather
than reading a reviewer's answer, and all six divergence paths were traced to a bank or a stall).
If the input domains do not overlap, they answer **different** questions and two implementations are
correct, no proof needed.

The worked boundary case, already ruled by a review gate:
[`packages/pipeline-cli/src/skill-shell-surface.ts`](../packages/pipeline-cli/src/skill-shell-surface.ts)
takes a markdown heading slice and returns that section's shell surface *as text*, appending the
content of each script the slice sources; `kp_skill_shell_surfaces` in
[`skills/shared/lib/common.sh`](../claude-plugins/kampus-pipeline/skills/shared/lib/common.sh)
takes a skill directory and returns its *file paths*, sorted. No input is accepted by both, so
neither can contradict the other — different questions, not duplication. The same file carries the
positive case: `sourcedScriptNames` is deliberately the *same* matcher `adoption-lint`'s claim pins
use, because "which script does this text source?" **is** one question, and three consumers
answering it three ways would be its own defect.

**The enforcement question (#4447's third criterion), settled: norm, not a new guard.** A guard that
reds on fenced shell re-entering `SKILL.md` cannot be written honestly — the sanctioned *invocation*
is itself a fenced shell block, so any such guard needs an arbitrary size or content threshold and
would assert far less than its name implies. That is the #4509 family, and adding a member of it to
police the extraction programme would be self-defeating. Enforcement is therefore the norm plus the
existing review gates for the judgement half, and the existing mechanical guards
(`trap-status-guard`, `cli-invocation-guard`, `skill-gh-lint`) for the parts that *are* mechanically
checkable. If re-embedding recurs at scale after phase 2, revisit with evidence — this ruling is
revisitable on that observable, not on preference.

**Binding constraints.**
- A combination of verb answers is relay only if it is total, mechanical, and UNKNOWN-propagating;
  failing any one of the three makes it a derive, and that logic becomes a verb by end of #1929.
- Every refusal path in an extracted script exits non-zero **and** prints a non-empty line.
- Extracted scripts set `set -uo pipefail` and install no `EXIT` trap.
- Before adding a second implementation of anything, state both as input → answer; if they share an
  input they answer one question — collapse it, or carry a recorded 0225-shape fail-safe proof.

**Banned.**
- A combination that introduces a threshold, a precedence between disagreeing verbs, a tie-break, or
  a regex that reinterprets a verb's output into a different category.
- Turning a verb's refusal into an empty set, a zero count, or a pass.
- A new guard whose subject population is "fenced shell in `SKILL.md`" under an arbitrary threshold.

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
- The enforcement ruling accepts a real residual: nothing mechanically stops new glue landing in
  skill markdown. That is a deliberate trade against a guard that would assert less than its name.

## Records

- Records the remaining rulings on #4447 (the combination case, the same-question test, and the
  enforcement question 0228 left explicitly deferred).
- Vocabulary impact: **redefines `derive-vs-relay`** (coined by ADR
  [0228](0228-scripts-relay-never-derive.md)) by adding the three-property combination qualifier.
  0228's routing of that term to [`.glossary/TERMS.md`](../.glossary/TERMS.md) never landed; the
  sharpened row is routed by #4525, since this PR touches only `.decisions/`.
