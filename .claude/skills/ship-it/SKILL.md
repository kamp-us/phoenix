---
name: ship-it
description: Ship one verified PR on kamp-us/phoenix — the authorized merge step the rest of the pipeline defers to. Given a PR number, assert review-code has signalled PASS, confirm CI is already green, squash-merge, and confirm the linked issue auto-closed. Trigger on "ship #N", "ship it", "it's merge-ready, ship it", "close the loop on #N", "merge #N", "/ship-it". This is the terminal stage of the issue-intake pipeline: it consumes the merge-ready signal review-code produces and is the ONLY skill granted merge authority.
---

# ship-it

You are the merge actor — the one stage authorized to merge a PR and close the loop.
`review-code` verified the PR against its issue's acceptance criteria and signalled
**merge-ready**, then stopped, because conflating "verified" with "merged" is the
self-grading collapse the gate exists to prevent. You are the separate, deliberate act it
defers to. See ADR [0048](../../../.decisions/0048-ship-it-merge-actor.md) for the why.

You ship **exactly one PR** per invocation. You do not sweep all open PRs — that fan-out
belongs to whatever loop drives the pipeline; keeping this stage atomic keeps it
composable and idempotent (re-running it on an already-merged PR is a clean no-op).

You ship **product-code** PRs the pipeline produced (`apps/web/**`, `packages/**`);
skill / harness changes (`.claude/**`, `.decisions/**`, `.patterns/**`) are a maintainer's
manual merge — the harness does not self-merge changes to itself (ADR
[0049](../../../.decisions/0049-pipeline-ships-code-not-itself.md)).

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
and PR queries. Every read and write goes through `gh api` REST or the `gh pr`/`gh run`
porcelain. This is not a style preference — GraphQL calls error out on this org.

## The two hard guards

These are the rules that make shipping safe; violate either and the gate above you was
pointless.

1. **Merge only on a PASS that is the current verdict.** You merge on the *latest* verdict
   being a PASS, never on the mere *presence* of a historical PASS nor the *absence* of a
   failure — a newer FAIL vetoes an older PASS (Step 2 resolves latest-wins across both
   verdict forms). No PASS marker and no approving review → you stop and report the PR as
   unverified. A red or pending check is not a "fail you can override" — it is a "not yet."
2. **You are the only skill that merges.** If you find yourself wanting to merge a PR
   that review-code hasn't passed, the answer is to route it back through review-code,
   not to merge it here.

## The merge-ready signal

`review-code` lands its verdict one of two ways (see
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §5):

- a native **approving review** (`event=APPROVE`), or
- a **pass-marker comment** whose first line is recognizably `review-code: PASS — merge-ready`.

The marker-comment path is the **default** to expect: the single operator on this repo
(`usirin`) cannot post an approving review on their own PR under org branch rules, so on
the common path review-code falls back to the marker comment. **You are the consumer the
marker was written for** — without you, that marker is an inert verdict nobody acts on.
Recognize the marker tolerantly by shape (`review-code: PASS` … `merge-ready`), not by
exact dashes.

review-code's gate is **stateless and re-runs**, so a PR can flip PASS → (new commits) →
FAIL or FAIL → PASS, and the two verdict forms interleave — an early approving review can be
overtaken by a later FAIL marker comment, or vice versa. So you never act on the *presence*
of a PASS; you act only on the **latest** verdict, where **the verdict is the newest of
{latest decisive review, latest review-code marker comment} by timestamp** (review
`submitted_at` vs comment `created_at`). A `review-code: FAIL` marker (or a
`CHANGES_REQUESTED` review) that is the latest verdict is the mirror signal: the PR has
unaddressed failures → you do not ship it. The fix round-trip is `write-code`'s job, not
yours.

---

## Step 1 — Resolve the PR and its linked issue

```bash
PR=<pr number>
gh api repos/kamp-us/phoenix/pulls/$PR \
  --jq '{number, state, draft, merged, mergeable, head: .head.ref, base: .base.ref, body}'
```

If the PR is already `merged` → nothing to do, report it shipped and stop (idempotent).
If it's `draft` or `state=closed` (unmerged) → stop, report why.

Find the linked issue from the PR body's `Fixes #N` / `Closes #N` (the seam `write-code`
writes and `review-code` relies on) and pin it as a shell var Step 5 reads back:

```bash
ISSUE=<N>
```

If there is **no** linked issue, stop and report `no linked issue`. In this pipeline
`write-code` always writes `Fixes #N`, so a missing link is a broken seam, not a normal
state — an unlinked PR has nothing to auto-close on merge and would leave dangling work.
This is distinct from the *linked-but-didn't-auto-close* case Step 5 handles: there the
seam exists but GitHub didn't fire it, which is recoverable; here the seam itself is
absent, which is an anomaly worth stopping on.

---

## Step 2 — Resolve the *latest* verdict, then branch on its polarity (guard 1)

You do **not** ship on the presence of any PASS that ever existed. review-code's gate is
stateless and re-runs, so a PR can go PASS → FAIL or FAIL → PASS, and the two verdict forms
(a native review and a marker comment) interleave. So compute the **single newest verdict
across both forms** and decide on *that* — the newest of {latest decisive review, latest
review-code marker comment}, compared by timestamp.

Read the latest of each form (sorted by timestamp, newest last — don't lean on the API's
return order for a merge decision):

```bash
# latest decisive review (APPROVED / CHANGES_REQUESTED), with its submit time
gh api "repos/kamp-us/phoenix/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, at: .submitted_at}'

# latest review-code marker comment (PASS or FAIL), with its create time
# `^` anchors at the start of the body: select only a comment whose FIRST LINE is the
# marker, not one that merely quotes the marker string somewhere in its body.
gh api "repos/kamp-us/phoenix/issues/$PR/comments?per_page=100" \
  --jq '[.[] | select(.body | test("^\\s*review-code:\\s*(PASS|FAIL)"; "i"))]
        | sort_by(.created_at) | last | {body, at: .created_at}'
```

Now decide:

1. If **both** forms are absent → **do not merge.** Report `unverified (no PASS signal)`
   and stop. This is guard 1: you act on the presence of a PASS, never the absence of a
   fail.
2. Compare the two `at` timestamps and take the **newer** event as the verdict (review
   `submitted_at` vs comment `created_at`; if only one form exists, it is the verdict).
3. Branch on the winner's polarity:
   - **PASS** — the newest verdict is an `APPROVED` review or a `review-code: PASS …
     merge-ready` marker → guard 1 cleared, proceed to Step 3.
   - **FAIL** — the newest verdict is a `CHANGES_REQUESTED` review or a `review-code: FAIL`
     marker → **do not merge.** The PR has unaddressed failures as its *current* state, even
     if an older PASS exists. Report `latest verdict is FAIL` and stop; the fix round-trip is
     `write-code`'s job, not yours.

The polarity of the **newest** event is the only thing that decides — an old PASS behind a
newer FAIL never ships, and an old FAIL behind a newer PASS does not block.

---

## Step 3 — Confirm CI is already green (one read, no polling)

You confirm checks; you do **not** own a wait-loop. Read the current check state once. The
human table and exit code can't cleanly separate red from pending, so read the per-check
states as a parseable rollup rather than trusting the exit code:

```bash
gh pr checks $PR --json name,state,bucket \
  --jq 'group_by(.bucket) | map({(.[0].bucket): length}) | add'
# bucket buckets each check into pass / fail / pending / skipping / cancel
```

Classify from the per-check states (not the exit code). `skipping` and `cancel` checks are
non-blocking — the "no `fail` and no `pending` → green" test already folds them in (a
skipped or cancelled check is neither a failure nor an in-flight wait):

- **All required checks green** (no `fail`, no `pending`) → proceed to Step 4.
- **Any check red (failing)** → do **not** merge. Route the failure to the self-heal lane
  (`/heal-ci` with this PR/run). **Until `heal-ci` exists, just report `checks red — not
  shipped`** (no hand-off to invoke yet). A failure-classifier decides flake-vs-defect; you
  only refuse to ship on red.
- **Checks still pending** (none red, some unfinished) → report `checks pending — not yet
  merge-ready` and stop. If the caller (a loop or a human) wants you to wait, they re-invoke
  you after CI settles; blocking on a multi-minute poll inside this atomic stage is out of
  scope.

Which checks are *required* follows the repo's CI config (the `check` + `unit` jobs
always; the path-gated `integration` job when the diff touches its trigger paths). Trust
`gh pr checks` for the rollup rather than hard-coding the job list.

---

## Step 4 — Squash-merge

Every guard cleared: a PASS signal is present (Step 2) and checks are green (Step 3).
Ship it with a squash merge so the issue's whole branch collapses to one commit on
`main`:

```bash
gh pr merge $PR --squash
```

The merge auto-closes the linked issue via its `Fixes #<ISSUE>` — that is the loop
closing. Do not separately close the issue; let the `Fixes` seam do it.

---

## Step 5 — Confirm the loop closed

Verify the terminal state rather than assuming the merge took:

```bash
gh api repos/kamp-us/phoenix/pulls/$PR --jq '{merged, merged_at}'
gh api repos/kamp-us/phoenix/issues/$ISSUE --jq '{state, state_reason}'
```

The issue should now read `state: closed`, `state_reason: completed`. If it didn't
auto-close (a missing/garbled `Fixes #N`), close it explicitly with a one-line note
pointing at the merged PR — but record that the seam was broken so it can be fixed
upstream.

---

## Running it

A single invocation ships one PR end to end: resolve the PR ↔ issue (Step 1), resolve the
latest verdict and merge only if its polarity is PASS (Step 2, guard 1), confirm green
checks (Step 3), squash-merge (Step 4), confirm the issue closed (Step 5).

Report back a tight terminal ledger — nothing else, because the merge itself is the
durable record:

```
PR #<PR> — issue #<ISSUE>
branch: <head ref>
PR url: <html_url>
merged: yes | no (<reason if no>)
issue closed: yes | no
```

If you refused to merge, the reason line is the whole point: `unverified (no PASS
signal)`, `latest verdict is FAIL`, `checks red — not shipped` (the pre-`heal-ci` reality;
becomes `routed to heal-ci` once that lane exists), `checks pending`, or `no linked issue`.
A refusal is a successful run — shipping the wrong PR is the only failure mode that matters.

## Conventions

This skill is the terminal stage of a suite (`report` → `triage` → `plan-epic` →
`write-code` → `review-code` → **`ship-it`**) that turns GitHub issues into an
agent-operable pipeline. The shared label semantics and the body/comment/dependency/marker
formats live in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) — you are
the merge step named as the reader of format 5; the decision to give the pipeline a single
merge authority is ADR [0048](../../../.decisions/0048-ship-it-merge-actor.md). Your input
is a PR that `review-code` signalled merge-ready; your output is a merged PR, a closed
issue, and a closed loop. You are the one stage with merge authority — guard it: never
merge on the absence of a failure, only on the presence of a verified PASS.
