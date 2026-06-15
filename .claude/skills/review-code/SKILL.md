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

## Step 2 — Read what the PR actually does, and exercise its product code

Verification is grounded in the diff, the tests, and — where it matters — the behavior,
not in the PR's self-description. Pull the change:

```bash
# the full diff — gh pr diff is the reliable form; the diff media type is the REST equivalent
gh pr diff $PR \
  || gh api repos/kamp-us/phoenix/pulls/$PR -H "Accept: application/vnd.github.v3.diff"
# files touched, at a glance
gh api "repos/kamp-us/phoenix/pulls/$PR/files?per_page=100" --jq '.[] | "\(.status)\t+\(.additions)/-\(.deletions)\t\(.filename)"'
```

### The trust split: head = code under test, base = the reviewer's instructions (ADR 0052)

You are reviewing the PR head, but you must never let it review *you*. The head's
`.claude/**`, root `CLAUDE.md`, hooks, `.decisions/**`, and `.patterns/**` are your own
operating instructions — and they are editable by the very PR under review. If you
checked out the head and ran in its tree, a PR could rewrite your instructions, suppress
a check, or install a hook *while you review it* (the trust inversion ADR
[0052](../../../.decisions/0052-review-code-config-isolation.md) closes). So the split is:
**product code comes from the head, your config/instructions come from the trusted base
ref.** You verify the head's behavior without ever loading the head's instructions.

**Mechanism: NON-cone sparse-checkout of the head's *product paths only* into a throwaway
worktree, fetched into a ref the session tree never switches to.**
Chosen over diff-only review (ADR 0052 rejects it — it forfeits behavior verification) and
over "load base config then trust the harness not to reload" (that *polices* the invalid
state rather than making it unrepresentable — ADR 0052 §Decision point 4). Two properties
make the isolation hold *by construction*, not by your remembering to behave:

- **Non-cone, not cone.** Cone mode (`--cone`) always materializes **every top-level file**
  regardless of the pattern set — it only filters sub-directories. So under cone mode the
  head's root `CLAUDE.md` would land on disk even if you never list it. Cone cannot express
  "the root directory minus `CLAUDE.md`." Non-cone mode (`--no-cone`) takes an explicit
  pattern allowlist, so it materializes *exactly* the product paths you name and **nothing
  else** — root `CLAUDE.md`, `.claude/**`, `.decisions/**`, `.patterns/**` are all absent
  from disk because they are never in the allowlist. The instruction surfaces cannot be on
  your path because they are never checked out.
- **The head reaches a ref, never your working tree.** You fetch the head into a dedicated
  ref (`refs/pr/$PR`) and add the throwaway worktree *from that ref*. Your own session tree
  is never switched, reset, or checked out to the head — so even the cross-fork path never
  materializes head-controlled config into the tree you operate from. The head's checks run
  *against* the product-only worktree via `pnpm -C`, never by switching your session into it.

Your own session stays in *this* worktree (the trusted base config you were launched under).

```bash
# the trusted base — the PR's merge target at tip; your config already comes from here
BASE_REF="$(gh api repos/kamp-us/phoenix/pulls/$PR --jq '.base.ref')"   # normally main

# Fetch the PR head into a dedicated ref WITHOUT touching the session tree. pull/$PR/head
# resolves for same-repo AND cross-fork PRs, so there is no separate cross-fork branch to
# check out into your own tree (the trust inversion ADR 0052 closes — never run
# `gh pr checkout`, which would materialize the head's config into the session checkout).
git fetch origin "pull/$PR/head:refs/pr/$PR"

REVIEW_WT="$(mktemp -d)/review-head-${PR}"
git worktree add --no-checkout "$REVIEW_WT" "refs/pr/$PR"
# NON-cone: explicit allowlist → ONLY these paths land; root CLAUDE.md, .claude/**,
# .decisions/**, .patterns/** are never materialized (cone mode would leak root CLAUDE.md).
git -C "$REVIEW_WT" sparse-checkout init --no-cone
git -C "$REVIEW_WT" sparse-checkout set \
  '/apps/' '/packages/' \
  '/pnpm-workspace.yaml' '/pnpm-lock.yaml' '/package.json' '/turbo.json' '/tsconfig.json'
git -C "$REVIEW_WT" checkout
```

The cross-fork case needs no special branch: `pull/$PR/head` is the GitHub-provided ref for
the PR head whether it lives on this repo or a fork, so the single `git fetch` above covers
both — and because it lands in `refs/pr/$PR` (not your working tree), head config never
reaches your instruction path on any path.

For criteria that assert *behavior* (a test passes, typecheck is clean, a command produces
an output), run the repo's commands **inside the product-only worktree** — behavior
verified by running beats behavior inferred from a diff:

```bash
pnpm -C "$REVIEW_WT" install   # if deps changed
pnpm -C "$REVIEW_WT" typecheck && pnpm -C "$REVIEW_WT" lint   # and/or the specific test the criterion names
rm -rf "$REVIEW_WT" && git worktree prune && git update-ref -d "refs/pr/$PR"   # tear the throwaway tree + ref down
```

Don't run more than the criteria demand — you're verifying *this issue's* checklist,
not auditing the whole repo. But for any criterion whose truth is observable by running
something, run it; that's the strongest evidence you can attach.

### Flag a control-plane PR (complementary signal, not the isolation)

The sparse-checkout above is what *keeps you safe*. Independently, note for the verdict
whether the PR's diff touches the **control plane** — and use **ADR 0053's blocking set
exactly**, because this flag predicts the *consumer's* (`ship-it`'s) behavior, and that
consumer refuses **only** the control plane. Two distinct sets are in play here; keep them
apart:

- **0052's instruction-trust set** (`.claude/**`, root `CLAUDE.md`, hooks, `.decisions/**`,
  `.patterns/**`) is what the reviewer must never *load* — already handled, above, by the
  non-cone allowlist that simply never checks those paths out. It is an *isolation* set, not
  a merge-blocking set.
- **0053's control-plane set** (`.claude/**` + `.github/**` **only**) is what `ship-it`
  *refuses to auto-merge* (ADR [0053](../../../.decisions/0053-control-plane-boundary.md) §4;
  ship-it/SKILL.md). `.decisions/**` and `.patterns/**` are **non-blocking** under 0053 —
  they auto-merge through `review-doc`. So the merge-blocking flag must match 0053's set, not
  0052's; flagging a `.decisions`/`.patterns`-only PR as "not auto-mergeable" would lie about
  what `ship-it` does and stall the autonomous doc lane.

So the verdict's not-auto-mergeable flag matches **`.claude/**` + `.github/**` only**:

```bash
CONTROL_PLANE_TOUCHED="$(gh api "repos/kamp-us/phoenix/pulls/$PR/files?per_page=100" \
  --jq '[.[].filename | select(test("^(\\.claude/|\\.github/)"))]')"
# non-empty → control-plane: surface it in the verdict (Step 4) as manual-merge per ADR 0053
```

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

First, **resolve the head SHA you actually reviewed** and **write the verdict to a per-PR
temp file** (`VERDICT_FILE="/tmp/review-code-verdict-${PR}.md"`) so multi-line markdown +
backticks survive the shell — both forms below read it back via `cat`. The PR number is in
the path so back-to-back runs never collide on a fixed file (a prior run's unread verdict
would otherwise stall the write or leak into this run). The SHA goes into the marker's first
line (`review-code: PASS @ <sha> — merge-ready`) — it is **load-bearing**: `ship-it` refuses
any verdict not bound to the PR's current head (ADR
[0058](../../../.decisions/0058-sha-bound-verdict-contract.md), issue #258). See the
verdict-body shape at the end of this step.

```bash
HEAD_SHA="$(gh api repos/kamp-us/phoenix/pulls/$PR --jq .head.sha)"   # the head you reviewed
```

**Preferred — an approving review** (the native, unambiguous GitHub signal). Capture its
result and check the exit status **explicitly**; on failure (e.g. a 422 when you can't
review your own org's PR under branch rules) post the marker-comment fallback. The explicit
check is load-bearing: do **not** chain APPROVE to the fallback with `||` — a shell pipe
wrapping the APPROVE call (e.g. `… 2>&1 | head` for inspection) makes the pipeline's exit
status mask the APPROVE failure, so the `||` fallback silently never fires and no verdict
lands.

The comment fallback **upserts**, it does not append: scan the PR for *your own* prior
`review-code:` marker comment and `PATCH` it with the fresh verdict instead of `POST`-ing a
new one, so there is exactly **one** `review-code` verdict comment per PR (ADR 0058 rule 2).
A re-review of a new head overwrites the same record with the new `@ <sha>`; the thread never
accumulates a stale verdict stream.

```bash
VERDICT_FILE="/tmp/review-code-verdict-${PR}.md"
BODY="$(cat "$VERDICT_FILE")"   # first line: review-code: PASS @ <HEAD_SHA> — merge-ready
if gh api -X POST repos/kamp-us/phoenix/pulls/$PR/reviews \
     -f event=APPROVE -f body="$BODY"; then
  : # native approving review posted (GitHub records its commit_id = the head you approved;
    #  ship-it reads that commit_id for the same staleness test the marker's @ <sha> drives)
else
  # APPROVE failed (e.g. 422 on your own PR) — upsert the structured pass comment instead,
  # whose first line is the SHA-bound marker so a scan finds the verdict unambiguously:
  #   review-code: PASS @ <HEAD_SHA> — merge-ready
  ME="$(gh api user --jq .login)"
  # --arg is a jq flag, not a gh-api one (ADR 0055), so pipe the fetched comments to standalone jq:
  comments=$(gh api "repos/kamp-us/phoenix/issues/$PR/comments?per_page=100")
  MINE=$(jq -r --arg me "$ME" 'map(select(.user.login==$me
            and (.body | test("^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)"; "i"))))
          | last | .id // empty' <<<"$comments")
  if [ -n "$MINE" ]; then
    gh api -X PATCH "repos/kamp-us/phoenix/issues/comments/$MINE" -f body="$BODY"   # upsert
  else
    gh api -X POST  "repos/kamp-us/phoenix/issues/$PR/comments"   -f body="$BODY"   # first verdict
  fi
fi
```

Either way, the verdict body states plainly: every acceptance criterion verified
(the table), the PR is **merge-ready**, and — explicitly — that **review-code does not
merge**; the **`ship-it`** skill is the authorized merge step, and merging this PR will
auto-close issue #N via its `Fixes #N`. Leave the issue as-is (it'll close on merge, not
now).

**Only if** `CONTROL_PLANE_TOUCHED` (Step 2) is non-empty, add the control-plane line to the
verdict: the PR is verified against its ACs **but is not auto-mergeable** — it touches
`.claude/**` or `.github/**`, so `ship-it` will refuse it and a human merges it by hand (ADR
[0053](../../../.decisions/0053-control-plane-boundary.md)). "Merge-ready" here means the
ACs are satisfied, not that the autonomous merge step may act. (A PR touching only
`.decisions/**`/`.patterns/**` is **not** control-plane and **does** auto-merge via
`review-doc` — do not add this line for it.)

Verdict body shape (this is what you wrote to `$VERDICT_FILE` above). The first line is the
**canonical bare marker** — no leading `**` emphasis, **with the `@ <HEAD_SHA>` you resolved
above** — per the matcher contract in [gh-issue-intake-formats.md](../gh-issue-intake-formats.md)
§5; matchers tolerate an optional leading `**` for backward compatibility, but emit the bare
form, and the `@ <sha>` is required (ADR 0058):

```markdown
review-code: PASS @ <HEAD_SHA> — merge-ready

Verified PR #<PR> against the acceptance criteria of #<ISSUE>, one at a time:

- [PASS] <criterion 1> — <evidence>
- [PASS] <criterion 2> — <evidence>
- …

All criteria pass. This PR is merge-ready. **review-code does not merge** — `ship-it` is
the authorized merge step; merging will auto-close #<ISSUE> via `Fixes #<ISSUE>`.

<!-- include the next block ONLY when CONTROL_PLANE_TOUCHED is non-empty -->
> ⚠️ **Control-plane PR** — diff touches `.claude/**` or `.github/**` (`<the matched paths>`).
> Per ADR 0053 this is **NOT auto-mergeable**: `ship-it` will refuse it; a human merges it by
> hand. ACs are verified; the merge is the human's call.
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

The first line, `review-code: FAIL @ <HEAD_SHA> — not merge-ready`, is a **recognizable,
SHA-bound marker** — the mirror of the PASS marker (formats §5). It is the seam
`write-code`'s resume-my-failed-PR path keys on: it scans for it to find a PR whose `Fixes #N`
issue is still claimed by the implementer and still has failing criteria *against the current
head* to address. Recognize it tolerantly by shape (`review-code: FAIL @ <sha>`), not by exact
dashes; the `@ <sha>` is required (ADR 0058). (And `ship-it` reads it as the mirror of PASS: a
FAIL marker means *do not merge*.)

Post it as an **upsert** — `PATCH` your own prior `review-code:` marker if one exists, else
`POST` — exactly as the PASS path (one `review-code` verdict comment per PR, ADR 0058 rule 2):

```bash
HEAD_SHA="$(gh api repos/kamp-us/phoenix/pulls/$PR --jq .head.sha)"   # the head you reviewed
BODY="$(cat "/tmp/review-code-verdict-${PR}.md")"   # first line: review-code: FAIL @ <HEAD_SHA> — not merge-ready
ME="$(gh api user --jq .login)"
# --arg is a jq flag, not a gh-api one (ADR 0055), so pipe the fetched comments to standalone jq:
comments=$(gh api "repos/kamp-us/phoenix/issues/$PR/comments?per_page=100")
MINE=$(jq -r --arg me "$ME" 'map(select(.user.login==$me
          and (.body | test("^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)"; "i"))))
        | last | .id // empty' <<<"$comments")
if [ -n "$MINE" ]; then
  gh api -X PATCH "repos/kamp-us/phoenix/issues/comments/$MINE" -f body="$BODY"
else
  gh api -X POST  "repos/kamp-us/phoenix/issues/$PR/comments"   -f body="$BODY"
fi
```

You *may* additionally request changes via a formal review
(`-f event=REQUEST_CHANGES`) for the native signal — but the **comment with
per-criterion evidence is the required artifact**; the review event is a nicety on top.

Verdict body shape:

```markdown
review-code: FAIL @ <HEAD_SHA> — not merge-ready

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
