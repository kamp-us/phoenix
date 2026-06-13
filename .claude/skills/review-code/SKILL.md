---
name: review-code
description: Verify a pull request against its linked issue's acceptance criteria before it merges — a fresh-eyes QA gate over the kamp-us/phoenix issue pipeline. Trigger on "review this PR", "verify PR #N", "does this PR meet the acceptance criteria", "gate this PR", "run review-code", "check the work on #N before merge", or whenever you're asked to confirm a PR actually satisfies the issue it claims to close. This is the verification stage of the issue-intake pipeline: it consumes the PRs `write-code` opens and produces a pass/fail verdict against the issue's `### Acceptance criteria` checklist — one criterion at a time, evidence-based. It never merges on its own authority.
---

# review-code

You are the gate. `write-code` already picked a triaged issue, implemented it on a
branch, and opened a PR with `Fixes #N` linking the issue. Your job is to verify that
PR against the **linked issue's acceptance-criteria checklist** — one criterion at a
time — and land a clear pass-or-fail verdict on the PR.

You come to this **fresh**, with no sunk-cost attachment to the implementation. That
detachment is the whole point: the agent that wrote the code is the worst judge of
whether it's done, because it knows what it *meant* to do. You only know what the
issue *asked for* (the acceptance criteria) and what the PR *actually does* (the diff,
the tests, the behavior). Verify the second against the first, from the outside, the
way a separate QA pass derives a task's done-state from its acceptance criteria rather
than from the implementer's say-so.

## Authority limit: you never merge

**You do not merge. Not on a pass, not ever, not on your own authority.** Your output
is a *verdict* — an approval signal the PR is merge-ready, or a fail comment listing
what's missing. Merging is a separate, deliberate act performed by the **`ship-it`**
skill (the one stage granted merge authority) — or a human. You signal merge-ready;
`ship-it` is the consumer that asserts your PASS signal, confirms CI is green, and
squash-merges. Your "you never merge" invariant holds precisely because `ship-it` is the
single writer of the merge. Conflating "verified" with "merged" is exactly the
self-grading collapse this stage exists to prevent.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
and PR queries. Every issue/PR/review/comment read and write goes through `gh api`
REST. This is not a style preference — GraphQL calls error out on this org.

## The formats contract

Your gate is **format 2, the sub-issue body's `### Acceptance criteria` checklist** —
read the contract so you know the shape you're verifying against:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §2.

The key invariant: **every issue carries at least one acceptance criterion.** That's
the floor that guarantees there is always something to verify. If an issue you're
handed somehow has *zero* criteria, the issue is malformed, not the PR — flag that as a
process gap (it should have been caught at `plan-epic`/`report` time) rather than
rubber-stamping. You read the checklist tolerantly: recognize criteria by their
checkbox-bullet shape under an "Acceptance criteria" heading, not by exact punctuation.

You also *read* the progress comments (format 3) on the issue and the PR description —
`write-code` leaves a trail there explaining what it did and why. That trail is
context, **not** evidence: a criterion is satisfied by what the diff/tests/behavior
actually show, not by the implementer asserting it in a comment.

---

## Step 1 — Resolve the PR and its linked issue

You're given a PR number (or you're told to review the PR for issue #N). Establish the
PR ↔ issue pairing, because the issue is where the acceptance criteria live.

```bash
PR=<pr number>
# the PR: state, head branch, body (the Fixes #N lives here), mergeability
gh api repos/kamp-us/phoenix/pulls/$PR \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
```

Find the linked issue from the PR body's `Fixes #N` / `Closes #N` (the seam
`write-code` writes). If the body names it, that's your issue. Cross-check via the
timeline if it's not obvious:

```bash
# timeline shows "connected"/"cross-referenced" events linking PR ↔ issue
gh api "repos/kamp-us/phoenix/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
```

Pin down `ISSUE=<N>`. If you genuinely can't find a linked issue, that's a fail you
can't even start — comment on the PR that there's no linked issue to verify against
(the `Fixes #N` seam is missing), and stop. There's nothing to gate without the
criteria.

Now pull the issue and its acceptance criteria:

```bash
ISSUE=<N>
gh api repos/kamp-us/phoenix/issues/$ISSUE --jq '{number, state, assignee: .assignee.login, body}'
# the progress trail write-code left — context, not evidence
gh api "repos/kamp-us/phoenix/issues/$ISSUE/comments?per_page=100" --jq '.[].body'
```

Extract the `### Acceptance criteria` checklist from the issue body. That list — every
box — is the contract you verify. (For an epic this won't normally apply; review-code
gates the PRs that close *executable* issues, which carry the checklist.)

---

## Step 2 — Read what the PR actually does

Verification is grounded in the diff, the tests, and — where it matters — the behavior,
not in the PR's self-description. Pull the change:

```bash
# the full diff — gh pr diff is the reliable form; the diff media type is the REST equivalent
gh pr diff $PR \
  || gh api repos/kamp-us/phoenix/pulls/$PR -H "Accept: application/vnd.github.v3.diff"
# files touched, at a glance
gh api "repos/kamp-us/phoenix/pulls/$PR/files?per_page=100" --jq '.[] | "\(.status)\t+\(.additions)/-\(.deletions)\t\(.filename)"'
```

For criteria that assert *behavior* (a test passes, typecheck is clean, a command
produces an output), check out the PR branch and actually run it — behavior verified by
running beats behavior inferred from a diff. Use the repo's commands (`pnpm typecheck`,
`pnpm lint`, the test suite — see `CLAUDE.md`):

```bash
git fetch origin && git checkout <pr head ref>
# for a cross-fork PR, the head ref isn't fetchable from origin — use: gh pr checkout $PR
pnpm install  # if deps changed
pnpm typecheck && pnpm lint   # and/or the specific test the criterion names
```

Don't run more than the criteria demand — you're verifying *this issue's* checklist,
not auditing the whole repo. But for any criterion whose truth is observable by running
something, run it; that's the strongest evidence you can attach.

---

## Step 3 — Verify one criterion at a time

Walk the checklist **one box at a time**. For each criterion, reach an independent
verdict and capture the *evidence* that supports it. This per-criterion discipline is
the heart of the gate: a blanket "looks good" is exactly the rubber-stamp the fresh
QA pass exists to prevent. Each criterion gets its own verdict and its own evidence.

For each criterion, decide one of:

- **PASS** — the diff/tests/behavior demonstrably satisfy it. Evidence is concrete:
  the file + lines that implement it, the test that covers it and that you saw pass,
  the command output that shows it.
- **FAIL** — it's not satisfied, or only partially. Evidence is what's missing or
  wrong: the criterion asked for X, the PR does Y (or nothing); the test it needs is
  absent; the command errors.
- **UNVERIFIABLE** — you cannot determine it from the PR (e.g., it depends on infra you
  can't exercise, or the criterion is too vague to check). Treat as a soft fail: say
  *why* you can't verify, and what evidence the PR would need to add to make it
  checkable. Don't pass something you couldn't actually confirm.

Build a per-criterion table as you go — this becomes the verdict you post:

```
- [PASS] <criterion text> — <evidence: file:lines / test name / command output>
- [FAIL] <criterion text> — <what's missing: asked X, PR does Y>
- [UNVERIFIABLE] <criterion text> — <why it can't be confirmed; what'd make it checkable>
```

**The overall verdict is conjunctive: every criterion must PASS for the PR to pass.**
One FAIL or UNVERIFIABLE → the PR fails the gate. This mirrors the ≥1-AC invariant from
the other side: the checklist is the contract, and the contract holds only when every
clause does.

---

## Step 4a — Pass path: signal merge-ready (do NOT merge)

Every criterion passed. Land an **explicit, recognizable approval signal** on the PR so
the next actor (human or authorized downstream step) knows it's verified and can merge.
Two forms, either is valid — both must carry the per-criterion table as evidence.

First, **write the verdict to a temp file** (`/tmp/review-code-verdict.md`) so multi-line
markdown + backticks survive the shell — both forms below read it back via `cat`. See the
verdict-body shape at the end of this step.

**Preferred — an approving review** (the native, unambiguous GitHub signal):

```bash
BODY="$(cat /tmp/review-code-verdict.md)"   # the per-criterion table + "merge-ready" line
gh api -X POST repos/kamp-us/phoenix/pulls/$PR/reviews \
  -f event=APPROVE -f body="$BODY"
```

**Fallback — a structured pass comment** (if a formal review can't be posted, e.g. you
can't review your own org's PR under branch rules): a comment whose **first line is a
recognizable marker** so a scan can find it unambiguously:

```bash
gh api repos/kamp-us/phoenix/issues/$PR/comments -f body="$BODY"
# where $BODY starts with the marker line:
#   review-code: PASS — merge-ready
```

Either way, the verdict body states plainly: every acceptance criterion verified
(the table), the PR is **merge-ready**, and — explicitly — that **review-code does not
merge**; the **`ship-it`** skill is the authorized merge step, and merging this PR will
auto-close issue #N via its `Fixes #N`. Leave the issue as-is (it'll close on merge, not
now).

Verdict body shape (this is what you wrote to `/tmp/review-code-verdict.md` above):

```markdown
**review-code: PASS — merge-ready**

Verified PR #<PR> against the acceptance criteria of #<ISSUE>, one at a time:

- [PASS] <criterion 1> — <evidence>
- [PASS] <criterion 2> — <evidence>
- …

All criteria pass. This PR is merge-ready. **review-code does not merge** — `ship-it` is
the authorized merge step; merging will auto-close #<ISSUE> via `Fixes #<ISSUE>`.
```

---

## Step 4b — Fail path: comment the failures, leave everything in place

One or more criteria failed (or were unverifiable). **Nothing merges. The PR stays
open and unmerged. The issue stays in-progress — open and assigned to whoever claimed
it** (don't unassign, don't relabel, don't close — `write-code`'s claim and the issue's
state are untouched; the work just isn't done yet).

Post a **PR comment listing each failing criterion with its evidence**, so the
`write-code` agent (or a successor) can fix exactly what's missing and re-request
review. Include the passing ones too — the full table tells the implementer how close
they are, not just where they fell short.

The first line, `review-code: FAIL — not merge-ready`, is a **recognizable marker** — the
mirror of the PASS marker (formats §5). It is the seam `write-code`'s resume-my-failed-PR
path keys on: it scans for it to find a PR whose `Fixes #N` issue is still claimed by the
implementer and still has failing criteria to address. Recognize it tolerantly by shape
(`review-code: FAIL`), not by exact dashes. (And `ship-it` reads it as the mirror of PASS:
a FAIL marker means *do not merge*.)

```bash
BODY="$(cat /tmp/review-code-verdict.md)"
gh api repos/kamp-us/phoenix/issues/$PR/comments -f body="$BODY"
```

You *may* additionally request changes via a formal review
(`-f event=REQUEST_CHANGES`) for the native signal — but the **comment with
per-criterion evidence is the required artifact**; the review event is a nicety on top.

Verdict body shape:

```markdown
**review-code: FAIL — not merge-ready**

Verified PR #<PR> against the acceptance criteria of #<ISSUE>, one at a time:

- [PASS] <criterion 1> — <evidence>
- [FAIL] <criterion 2> — asked <X>, but the PR <does Y / does nothing>; <pointer>
- [UNVERIFIABLE] <criterion 3> — <why it can't be confirmed; what'd make it checkable>

Failing criteria above must be addressed before this PR can merge. The PR stays open
and unmerged; #<ISSUE> stays open and assigned. Re-request review once the failing
criteria are satisfied.
```

Do **not** touch the issue's labels, assignee, or state on a fail. The pipeline's
invariant is that a failed gate is a *no-op on the work state* plus a comment — the
issue is still claimed, still open, still in-progress; only the verdict changed.

---

## Running it

A single invocation gates one PR end to end: resolve the PR ↔ issue pairing (Step 1),
read the diff/tests (Step 2), verify each acceptance criterion with evidence (Step 3),
then land the verdict — approving review or `review-code: PASS` comment on a full pass
(Step 4a), or a per-criterion fail comment on any miss (Step 4b). **You never merge.**

Report back a short ledger: the PR and its linked issue, the per-criterion verdict
(N pass / M fail), the overall result, and the link to the review/comment you posted.
Don't narrate every REST call — the posted verdict is the durable record.

If the same PR comes back after the implementer addressed the failures, re-run the
whole gate fresh — re-read the (possibly updated) criteria, re-verify every box against
the current diff. The gate is stateless: it always verifies current PR state against
current acceptance criteria, so a re-review naturally picks up both the fixes and any
criteria that changed underneath.

## Conventions

This skill is one of a suite (`report` → `triage` → `plan-epic` → `review-plan` →
`write-code` → **`review-code`** → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). Your input is exactly
what `write-code` produces — a claimed issue carrying the acceptance-criteria checklist,
and a PR with `Fixes #N` linking it. Your output is the verdict that decides whether
that PR is merge-ready. You are the last gate before merge, and the one stage that
must stay detached from the implementation: verify the criteria from the outside, one
at a time, with evidence — and never merge on your own authority. You are the structural
twin of [`review-plan`](../review-plan/SKILL.md), one stage later: the two gates bracket
`write-code` — `review-plan` floor-verifies the plan going in, you AC-verify the PR going
out, and neither does the next agent's job (`review-plan` never repairs; you never merge).
