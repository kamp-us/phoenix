---
id: 0051
title: Author-Bind ship-it's PASS Signal — Only the Operator Identity Can Pass a PR
status: proposed
date: 2026-06-13
tags: [pipeline, skills, ship-it, review-code, security, agents]
---

# 0051 — Author-Bind ship-it's PASS Signal — Only the Operator Identity Can Pass a PR

## Context

`ship-it` Step 2 resolves the merge verdict by reading PR comments and matching
`review-code:\s*(PASS|FAIL)` on the first line, latest-wins by timestamp — with **no
check on the comment author** (`.claude/skills/ship-it/SKILL.md`, Step 2). Any actor that
can comment on the PR can plant `review-code: PASS — merge-ready`, and `ship-it` treats it
as a real verdict and merges. In a fully-autonomous loop, `write-code` — or anything with
comment access — posting that line would make `ship-it` ship a PR `review-code` never
verified.

This is not a fringe path. ADR [0048](0048-ship-it-merge-actor.md) and `ship-it`'s own
SKILL.md call the marker-comment path the **default to expect**: the solo operator
(`usirin`) cannot post an approving review on their own PR under org branch rules, so on the
common path `review-code` falls back to the marker comment (`review-code/SKILL.md`,
"Fallback — a structured pass comment"). The native approving-review path (`event=APPROVE`)
*is* author-attributed by GitHub and unforgeable by a non-reviewer, but `ship-it` treats
both forms as equals under latest-wins. The weakest link sets the floor: the *default,
load-bearing* merge signal is the forgeable one. This is a "make invalid states
unrepresentable" violation — a forged PASS is currently representable and indistinguishable
from a real one.

The fix is an author check, but *what* identity counts as authorized is the real decision,
and it has to land *with* ADR 0048's single-operator constraint, not around it. Two
candidate mechanisms were named in #185 (split from #183, Gap 1):

- **(a) Author-bind the marker** — `ship-it` honors a `review-code: PASS` marker only from
  an authorized identity and ignores it from any other author.
- **(b) Make the native review event canonical, demote the marker to an author-verified
  fallback** — prefer `event=APPROVE`, fall back to the marker only when an approving review
  is structurally impossible, and even then verify the marker author.

A grounding fact decides between them: every pipeline skill on this repo runs as the **same
GitHub identity — the operator `usirin`** — including `review-code`, which posts the marker
comment, and `write-code`, which opens the PR. So the operator is *both* the only legitimate
verdict author *and* (today) the only actor in the loop. There is no separate review-bot
identity yet; the org-branch-rule constraint that forces the marker fallback is precisely
that `usirin` can't `APPROVE` their own `usirin`-authored PR.

## Decision

`ship-it` **author-binds the PASS signal to an allowlist of authorized verdict identities**,
and treats a marker from any other author as if it did not exist (option (a), refined so the
native-review path (b) is its automatic, already-unforgeable special case).

1. **Authorized verdict identity.** The authorized identity is the **pipeline operator
   identity** — concretely `usirin` today, expressed as a small allowlist
   (`AUTHORIZED_REVIEWERS`) so a future dedicated review-bot identity is one entry away
   without re-litigating this decision. The allowlist is the single source of truth for
   "whose PASS counts."

2. **Marker comments are author-checked.** When resolving the latest marker comment in
   Step 2, `ship-it` selects only comments whose `user.login` is in the allowlist. A
   `review-code: PASS` (or `FAIL`) marker from any author **not** on the allowlist is
   **ignored entirely** — not counted as a verdict, not even as a FAIL — exactly as if it
   were ordinary PR chatter. The `gh api .../issues/$PR/comments` jq filter gains a
   `select(.user.login | IN($authorized[]))` clause alongside the existing first-line
   marker test.

3. **Native approving reviews are canonical and inherit this for free.** An `event=APPROVE`
   review is author-attributed by GitHub and cannot be forged by a non-reviewer, so the
   native-review form is the unforgeable path by construction. `ship-it` continues to treat
   the latest *decisive review* (`APPROVED`/`CHANGES_REQUESTED`) as a verdict form; because
   GitHub already binds its author, no extra allowlist check is needed there — option (b)'s
   "native event is canonical" is satisfied automatically. The marker is the author-verified
   fallback for the case where a native review is structurally impossible (the operator's own
   PR).

4. **Unauthorized/unattributed PASS ⇒ unverified.** If, after the author filter, **no**
   authorized verdict exists in either form, `ship-it` reports the PR as `unverified (no PASS
   signal)` and stops — the same terminal state as a PR with no marker at all. A forged PASS
   from an unauthorized author therefore lands `ship-it` in *refuse-and-report*, never in
   *merge*. This closes the Step 2 forgeability seam: an unauthorized marker is
   unrepresentable as a verdict.

5. **No weakening of the existing guards.** Latest-wins across the two verdict forms (guard
   1, ADR 0048) is unchanged; the author check is applied *before* the latest-wins
   comparison, so the timeline `ship-it` reasons over contains only authorized verdicts. A
   newer authorized FAIL still vetoes an older authorized PASS.

The implementation (editing `ship-it` Step 2's jq filter + threading the allowlist) is a
**downstream follow-up issue** gated on this ADR being accepted; this decision fixes the
*approach and the authorized identity* so that issue can act without re-opening the choice.

### Why (a)-refined over plain (b)

Plain (b) — "make the native event canonical, marker is fallback" — does not by itself fix
the forgeable default: it still *uses* the marker on the common path (the operator's own
PR), and an unauthored marker on that path is exactly the hole. (b)'s own escape hatch
("even then verify the marker author") *is* the author-bind of (a). So (a) is the load-
bearing mechanism and (b) is the natural ordering of forms once (a) is in place. Adopting
(a) as the rule and folding (b) in as "native reviews are canonical and already
author-bound" gives one mechanism that covers both forms, rather than two rules whose
overlap is the actual fix.

### Why an allowlist, not "the PR author can't be the verdict author"

A tempting cheaper rule — "ignore a PASS whose author is the PR author" — fails the
single-operator reality: `usirin` is *both* the PR author and the legitimate verdict author
(review-code runs as `usirin`). That rule would reject every real verdict on the default
path. The allowlist inverts the test correctly: a verdict is authorized by *being on the
list*, independent of who opened the PR. It also makes the future multi-agent world
expressible — add a `review-code[bot]` identity to the list — without changing the rule.

## Consequences

- **Easier / safer:** the default merge signal stops being forgeable. A forged PASS from any
  identity not on the allowlist is inert; `ship-it` can only be driven to merge by a verdict
  from an authorized identity or a GitHub-attributed approving review. The forgeable state is
  no longer representable as a verdict.
- **Concrete authorized identity:** "whose PASS counts" is a named, single-source allowlist
  (`usirin` today), so the trust boundary is auditable and the future review-bot is a
  one-line change, not a redesign.
- **Harder / new cost:** `ship-it` Step 2 must read each marker comment's `user.login` and
  filter; the allowlist must be maintained somewhere `ship-it` can read it (start: inline in
  the skill, named `AUTHORIZED_REVIEWERS`). A misconfigured/empty allowlist fails *closed*
  (no authorized verdict ⇒ unverified ⇒ refuse), which is the safe direction.
- **Banned:** honoring a `review-code: PASS`/`FAIL` marker from an author not on the
  allowlist; deriving authorization from "not the PR author" rather than from the allowlist;
  treating the marker form as equal to a native review *without* the author check.
- **Relationship:** extends ADR [0048](0048-ship-it-merge-actor.md) — 0048 made the marker a
  first-class PASS signal `ship-it` consumes; this ADR makes *which* markers `ship-it` will
  consume unforgeable, keeping 0048's single-operator premise intact (the operator's own
  marker still passes; a stranger's never does). Sibling to #183 Gap 2 (branch-controlled
  reviewer config), which is out of scope here. As a `.claude` / `.decisions` harness change
  this ADR and its eventual `ship-it` edit are **manual-merge** per ADR
  [0049](0049-pipeline-ships-code-not-itself.md); the pipeline does not self-merge changes to
  its own merge authority.
