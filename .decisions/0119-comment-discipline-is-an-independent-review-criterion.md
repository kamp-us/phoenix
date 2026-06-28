---
id: 0119
title: Comment-Discipline Is an Independent review-code Criterion, Not the Author's Self-Check — the Fresh-Eyes Judge Removes the Author Bias
status: accepted
date: 2026-06-28
tags: [pipeline, review-code, comments, split-role]
---

# 0119 — Comment-Discipline Is an Independent review-code Criterion, Not the Author's Self-Check — the Fresh-Eyes Judge Removes the Author Bias

## Context

CLAUDE.md holds a standing rule — **"Comments earn their place or die"** — and the
[`deslop-comments`](../claude-plugins/kampus-pipeline/skills/deslop-comments/SKILL.md)
skill is its rubric. Issue [#1242](https://github.com/kamp-us/phoenix/issues/1242) asked
the pipeline to *enforce* that rule on the AI-generated over-commenting that reliably
lands in fresh diffs (narration of obvious control flow, comments restating the symbol,
docblocks re-deriving a *why* an ADR already owns). #1242 was closed by #1348, which added
**write-code Step 4c — "self-deslop your own freshly-generated diff."** Step 4c is an
**author self-check, never a gate**: the coder that just wrote the code runs the rubric
over its own changed comment lines before pushing. #1348 recorded a "Placement rationale"
choosing this author-seat placement (a) over a review-code finding (b) or both (c), on the
grounds that comment density is "a self-correctable authoring concern, not a correctness
contract the independent gate must adjudicate."

Issue [#1394](https://github.com/kamp-us/phoenix/issues/1394) reopens that exact choice
with merged-PR evidence that placement (a) does not hold — and not because Step 4c is
under-tuned, but because it is **structurally author-biased**. The same agent that just
wrote each justification, believing every line earned its place, is the worst judge of its
own slop. This is the **identical self-evaluation bias the pipeline already pays a separate
reviewer to remove for code correctness** — yet comment-discipline, alone among the diff's
quality axes, was left at the author's seat. The evidence: PRs #1380 (`d208092`) and #1378
(`b11d4ef`) both merged at ~29% added-comment-line ratio, with the *same* concurrency-race
invariant re-derived ~3× across a `VouchOutcome` docblock, a `castVouch` docblock, and an
inline comment — exactly the redundant re-derivation Step 4c's own rubric says to COLLAPSE.
Step 4c ran (the #1242 invocation gap is closed) and the slop still landed.

The "self-correctable authoring concern" framing is what the evidence falsifies. A concern
that is self-correctable *in principle* but provably *not self-corrected in practice* —
because the corrector is biased — needs an independent check. And review-code already
adjudicates standing, non-AC diff-hygiene that does not trace to any single issue's goal:
it gates `lint:worktree`, `typecheck`, and (via the ADR 0079 fan-out) the
"make-invalid-states-unrepresentable" type-design bar. Comment-discipline is the same
*kind* of thing — a standing repo invariant over the diff — not a category the gate must be
kept away from.

## Decision

**Comment-discipline is verified by the independent reviewer in `review-code`, as a
standing diff-hygiene criterion over the PR's added/changed comment lines.** The fresh-eyes
reviewer — not the author — is the judge of whether the diff carries comment slop, applying
the `deslop-comments` rubric verbatim (its one test; its CUT / COLLAPSE / MIGRATE / KEEP
categories; its load-bearing KEEP carve-out). A slop finding contributes to the
conjunctive `review-code` verdict like `lint`/`typecheck`: it FAILs the PR with the
specific slop sites named, and routes through the **existing bounded repair loop** —
write-code's repair mode deslops on the same branch, an independent re-review re-gates. The
author may *fix*; the author never *judges*. This removes the author bias by construction,
because the bias lived in the **judge** role, and the judge is now the independent gate —
the same firewall that already removes self-evaluation bias for correctness.

This is **not** an ADR 0079 fan-out dimension. The three fan-out dimensions (silent-failure,
type-design, test-gap) are *correctness* axes routed by tracing to the linked issue's stated
goal (in-scope → AC append; out-of-scope → `report`). Comment slop does not make the feature
*wrong* and does not trace to the issue goal — it is diff *hygiene*, parallel to `lint`/
`typecheck`, which review-code already gates as standing criteria outside the AC checklist.
So comment-discipline joins that standing-criterion tier, not the goal-traced AC route.

**Step 4c stays — demoted from "the enforcement" to a cheap author-side pre-pass (defense in
depth).** Keeping the author's self-deslop is strictly better than removing it: it cuts the
slop that reaches the gate, so fewer repair rounds are spent on it. But it is no longer *the*
mechanism that keeps slop out of merged diffs — the independent gate is. #1348's superseded
"Placement rationale" is rewritten to point here.

The judge is a **judging reviewer applying the rubric**, never a mechanical comment-ratio
threshold. A density heuristic cannot tell a load-bearing concurrency invariant from
narration slop — the #1380 comments were themselves "borderline load-bearing" — so it would
false-FAIL the notes the rubric's KEEP category exists to protect and false-PASS terse slop.
The `deslop-comments` "one test" (*would the next agent be wrong, slower, or surprised
without this comment, in a way the code itself doesn't already tell them?*) is judgment by
design; the gate carries that judgment, not a number.

## Consequences

- **The author bias is gone by construction.** Comment-discipline now gets the same
  fresh-eyes pass correctness already gets; the asymmetry #1394 named (correctness reviewed,
  comments self-graded) is closed. The judge is independent; the author only fixes — the
  split-role firewall and the repair loop are unchanged, so no new firewall surface and no
  new pipeline agent are introduced (unlike a separate post-write-code "deslop pass," which
  would have a non-author mutate the very head the gate then reviews).
- **review-code is gate-critical (§CP).** This edit lands in a §CP skill, so the implementing
  PR is **control-plane → human merge** (ADRs 0053 / 0065), not auto-shipped on a PASS.
- **A new standing FAIL class on code PRs.** A diff with un-earned comment churn now FAILs
  review-code until deslopped, costing a repair round. This is the intended cost — the same
  shape as a `lint` FAIL — and the `deslop-comments` KEEP carve-out bounds it: load-bearing
  invariants, workaround rationale, deliberate-looking-wrong guards, and ADR pointers are
  explicitly *not* slop and never FAIL. The criterion is **scoped to the diff's added/changed
  comment lines only** (never a drive-by sweep of untouched code), so it does not widen what
  the gate must verify.
- **No re-derivation of the rubric.** review-code and write-code Step 4c both *cite*
  `deslop-comments/SKILL.md` as the single source of the categories and the KEEP carve-out;
  neither restates a stricter rule. The rubric drifts in one place or not at all.
- **Rejected alternatives, recorded.** *(1) Strengthen Step 4c in place* (the report's
  suggestion 4) leaves the author as judge — more instructions to a biased judge do not
  remove the bias; it targets the symptom, not the root cause. *(2) A separate independent
  deslop pass* (suggestion 1) adds a new agent and a new firewall surface (a non-author
  writing the reviewed head) for no benefit over reusing the gate. *(3) A mechanical
  comment-ratio soft-signal* (suggestion 3) cannot exercise the rubric's judgment and would
  fight the KEEP carve-out. *(4) #1348's placement (a)* — author self-check as the sole
  enforcement — is **superseded** by this ADR: its premise ("self-correctable, the gate need
  not adjudicate") is falsified by #1380/#1378.
