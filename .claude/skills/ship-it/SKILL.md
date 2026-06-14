---
name: ship-it
description: Ship one verified PR on kamp-us/phoenix — the authorized merge step the rest of the pipeline defers to. Given a PR number, assert the matching gate has signalled PASS (review-code for code, review-doc for docs), confirm CI is already green, squash-merge, and confirm the linked issue auto-closed — and REFUSES to self-merge control-plane PRs (.claude/.github), which a human merges by hand (ADR 0053). Trigger on "ship #N", "ship it", "it's merge-ready, ship it", "close the loop on #N", "merge #N", "/ship-it". This is the terminal stage of the issue-intake pipeline: it consumes the merge-ready signal the gates produce and is the ONLY skill granted merge authority.
---

# ship-it

You are the merge actor — the one stage authorized to merge a PR and close the loop.
A gate (`review-code` for product code, `review-doc` for docs) verified the PR against its
issue's acceptance criteria (code) or doc-quality bar (docs) and signalled **merge-ready**,
then stopped, because conflating
"verified" with "merged" is the self-grading collapse the gate exists to prevent. You are the
separate, deliberate act it defers to. See ADR [0048](../../../.decisions/0048-ship-it-merge-actor.md)
for the why — note that gate is now one of two (`review-code`/`review-doc`) under ADR
[0053](../../../.decisions/0053-control-plane-boundary.md), so 0048's prose, which predates the
split, only discusses `review-code`.

You ship **exactly one PR** per invocation. You do not sweep all open PRs — that fan-out
belongs to whatever loop drives the pipeline; keeping this stage atomic keeps it
composable and idempotent (re-running it on an already-merged PR is a clean no-op).

## The control-plane boundary — what you may auto-merge

A PR is in one of two classes by the files it touches (ADR
[0053](../../../.decisions/0053-control-plane-boundary.md), which supersedes
[0049](../../../.decisions/0049-pipeline-ships-code-not-itself.md)):

- **BLOCKING — never auto-merged.** Any PR touching `.claude/**` or `.github/**` is the
  agent control plane: agent instructions/tools/hooks (`.claude`) and CI enforcement
  (`.github`). A bad merge here is a serious security concern — self-modification of the
  guardrails, or CI/secret exfiltration. A human merges these by hand; the pipeline NEVER
  self-merges them. If the diff touches even one such file, you **refuse** (see Step 0).
- **NON-BLOCKING — autonomous.** Everything else — `apps/web/**`, `packages/**`,
  `.decisions/**`, `.patterns/**`, and other prose docs. These are product or knowledge
  artifacts; they are gated for quality, but a human at the merge adds no security value, so
  you ship them once the matching gate PASSes.

Note `.decisions/**` and `.patterns/**` are **non-blocking** under 0053 — they auto-merge
through `review-doc` (the boundary moved off "harness vs not" to "control plane vs not").

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
and PR queries. Every read and write goes through `gh api` REST or the `gh pr`/`gh run`
porcelain. This is not a style preference — GraphQL calls error out on this org.

## The two hard guards

These are the rules that make shipping safe; violate either and the gate above you was
pointless.

1. **Merge only on a PASS that is the current verdict.** You merge on the *latest* verdict
   being a PASS, never on the mere *presence* of a historical PASS nor the *absence* of a
   failure — a newer FAIL vetoes an older PASS (Step 2 resolves latest-wins per gate
   namespace). No PASS marker and no approving review → you stop and report the PR as
   unverified. A red or pending check is not a "fail you can override" — it is a "not yet."
2. **You are the only skill that merges.** If you find yourself wanting to merge a PR a gate
   hasn't passed, the answer is to route it back through that gate (`review-code` /
   `review-doc`), not to merge it here.

## The merge-ready signals

The pipeline runs **two gates**, one per artifact class, each landing its verdict as a
first-line marker comment:

- **product code** (`apps/web`, `packages`, other code) → `review-code`, whose marker is
  `review-code: PASS — merge-ready` or `review-code: FAIL — not merge-ready` (the canonical
  shape is [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §5, which covers
  the `review-code` namespace only). `review-code` can also land a native **approving
  review** (`event=APPROVE`).
- **docs** (`.decisions`, `.patterns`, prose `*.md` outside `.claude`/`.github`) →
  `review-doc`, whose marker is `review-doc: PASS — merge-ready` or
  `review-doc: FAIL — changes-requested`. The formats contract does not yet define the
  `review-doc` namespace, so the shapes stated here are the consumed contract: `PASS …
  merge-ready` is read by `ship-it`, `FAIL … changes-requested` by the doc author's fix
  round-trip. (When `review-doc` lands, extend §5 to define both namespaces and point this
  citation there.)

The marker-comment path is the **default** to expect: the single operator on this repo
(`usirin`) cannot post an approving review on their own PR under org branch rules, so on
the common path the gate falls back to a marker comment. **You are the consumer the markers
were written for** — without you, they are inert verdicts nobody acts on. Recognize a marker
tolerantly by shape (`review-code: PASS` … `merge-ready`, `review-code: FAIL` … `not
merge-ready`, `review-doc: PASS` … `merge-ready`, `review-doc: FAIL` … `changes-requested`),
not by exact dashes.

Each gate is **stateless and re-runs**, so a PR can flip PASS → (new commits) → FAIL or
FAIL → PASS, and (for code) the marker and the native-review forms interleave. So you never
act on the *presence* of a PASS; you act only on the **latest** verdict per gate. A FAIL
marker (or a `CHANGES_REQUESTED` review) that is the latest verdict for an artifact class
present in the diff is the mirror signal: the PR has unaddressed failures → you do not ship
it. The fix round-trip is `write-code`'s (code) / the doc author's job, not yours.

---

## Step 0 — Classify the diff against the control-plane boundary (guard 0)

Before anything else, read the PR's changed files and split them by class. This is one read:

```bash
PR=<pr number>
gh api "repos/kamp-us/phoenix/pulls/$PR/files?per_page=300" --jq '[.[].filename]'
```

Classify each path:

- **control plane (blocking):** matches `.claude/**` or `.github/**`.
- **code:** under `apps/web/**` or `packages/**` (the `^(apps/web|packages)/` probe); a source path matching neither this nor the doc probe still defaults to code, requiring a `review-code` PASS, so nothing under-gates.
- **docs:** `.decisions/**`, `.patterns/**`, or a prose `*.md` *outside* `.claude`/`.github`.

```bash
FILES=$(gh api "repos/kamp-us/phoenix/pulls/$PR/files?per_page=300" --jq '.[].filename')
echo "$FILES" | grep -Eq '^(\.claude|\.github)/' && echo "BLOCKING"   # control plane present?
echo "$FILES" | grep -Eq '^(apps/web|packages)/' && echo "has-code"   # rough code probe
echo "$FILES" | grep -Eq '^(\.decisions|\.patterns)/|\.md$' && echo "has-docs"
```

**Routing:**

- If **any** file is control plane (`.claude/**` or `.github/**`) → **REFUSE.** Report
  `blocking — manual merge` and stop. A human merges the control plane by hand (ADR 0053);
  the pipeline never self-merges its own guardrails. This holds even if the rest of the diff
  is clean code/docs — a mixed PR that touches the control plane is still a manual merge, and
  should be split so the non-blocking half can flow.
- Otherwise, note which **artifact classes are present** (code, docs, or both). Step 2
  requires the matching gate's latest verdict = PASS for **each class present**: code →
  `review-code` PASS; docs → `review-doc` PASS; a mixed code+doc PR needs **both**. Carry the
  class set into Step 2.

The `.md$` probe over-matches (it catches code-adjacent markdown too); that's fine — it only
decides *whether to require a review-doc PASS*, and requiring one extra PASS never makes an
unsafe merge. The control-plane check is the only one that must be exact, and it is.

---

## Step 1 — Resolve the PR and its linked issue

```bash
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

## Step 2 — Resolve the *latest* verdict per gate namespace, then branch on polarity (guard 1)

You do **not** ship on the presence of any PASS that ever existed. Each gate is stateless and
re-runs, so a PR can go PASS → FAIL or FAIL → PASS. Resolve **`review-code` and `review-doc`
in separate namespaces** — two anchored regexes that never cross-match — and require a latest
PASS in **each namespace whose artifact class is present** (from Step 0). A review-code scan
must never match a review-doc marker, or vice versa.

The two anchors (case-insensitive, anchored at the start of the comment body so a comment
that merely *quotes* a marker mid-body doesn't match):

- code: `^\s*review-code:\s*(PASS|FAIL)`
- doc:  `^\s*review-doc:\s*(PASS|FAIL)`

A marker comment counts as a verdict **only if its author is on the allowlist below** — the
two marker filters gate on `.user.login` *before* the marker regex, so a forged
`review-code: PASS` / `review-doc: PASS` from any other commenter (the `write-code` agent, a
stranger) is invisible to the resolution, treated exactly as ordinary PR chatter, never as a
verdict and never as a FAIL (ADR [0051](../../../.decisions/0051-author-bind-pass-marker.md)).
`AUTHORIZED_REVIEWERS` is the single source of truth for *whose* PASS counts; today it is the
solo operator `usirin` (who can't `APPROVE` their own PR under org branch rules, so their
marker is the load-bearing default — ADR 0048). A future dedicated review-bot identity is one
entry away — add its `login` to the list, no re-decision needed.

```bash
AUTHORIZED_REVIEWERS='["usirin"]'
```

Read the latest of each form (sorted by timestamp, newest last — don't lean on the API's
return order for a merge decision):

```bash
# latest decisive native review (APPROVED / CHANGES_REQUESTED) — the review-code path only.
# GitHub author-attributes reviews, so this path is unforgeable and needs no allowlist check.
gh api "repos/kamp-us/phoenix/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, at: .submitted_at}'

# latest review-code marker comment (code namespace) — author-gated, anchored, never matches review-doc
gh api "repos/kamp-us/phoenix/issues/$PR/comments?per_page=100" \
  --argjson authorized "$AUTHORIZED_REVIEWERS" \
  --jq '[.[] | select(.user.login | IN($authorized[]))
              | select(.body | test("^\\s*review-code:\\s*(PASS|FAIL)"; "i"))]
        | sort_by(.created_at) | last | {body, at: .created_at}'

# latest review-doc marker comment (doc namespace) — author-gated, anchored, never matches review-code
gh api "repos/kamp-us/phoenix/issues/$PR/comments?per_page=100" \
  --argjson authorized "$AUTHORIZED_REVIEWERS" \
  --jq '[.[] | select(.user.login | IN($authorized[]))
              | select(.body | test("^\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
        | sort_by(.created_at) | last | {body, at: .created_at}'
```

Now resolve **per namespace**, latest-wins by timestamp:

- **review-code namespace** — the verdict is the **newest of {latest decisive review, latest
  review-code marker comment}** by timestamp (review `submitted_at` vs comment `created_at`).
  An `APPROVED` review or a `review-code: PASS … merge-ready` marker is PASS; a
  `CHANGES_REQUESTED` review or a `review-code: FAIL` marker is FAIL. (The native approving-review
  path stays; it interleaves only with the review-code markers, never with review-doc.)
- **review-doc namespace** — the verdict is the **latest `review-doc` marker comment** by
  `created_at`. `review-doc: PASS … merge-ready` is PASS; `review-doc: FAIL … changes-requested`
  is FAIL. (review-doc lands no native review, so there is no review path to fold in.)

Then gate the merge on the classes present (Step 0):

1. For **each class present**, its namespace must have a latest verdict and it must be PASS.
   - code present but the review-code namespace is empty → `unverified (no review-code PASS)`.
   - docs present but the review-doc namespace is empty → `unverified (no review-doc PASS)`.
   - a mixed code+doc PR needs **both** namespaces resolved to PASS.
2. If **any** required namespace's latest verdict is **FAIL** → **do not merge.** The PR has
   unaddressed failures as its *current* state, even if an older PASS exists. Report
   `latest verdict is FAIL (<which gate>)` and stop; the fix round-trip is `write-code`'s
   (code) / the doc author's job, not yours.
3. If **every** required namespace's latest verdict is PASS → guard 1 cleared, proceed to
   Step 3.

The polarity of the **newest** event in each namespace is the only thing that decides — an
old PASS behind a newer FAIL never ships, and an old FAIL behind a newer PASS does not block.

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
- **Any check red (failing)** → do **not** merge. Route the failure to the self-heal lane:
  invoke [`/heal-ci`](../heal-ci/SKILL.md) with this PR/run, then report the result (e.g.
  `routed to heal-ci`). `heal-ci` decides flake-vs-defect (one bounded rerun of a transient,
  or a `report`-filed defect); you only refuse to ship on red and hand off — you still do not
  merge.
- **Checks still pending** (none red, some unfinished) → report `checks pending — not yet
  merge-ready` and stop. If the caller (a loop or a human) wants you to wait, they re-invoke
  you after CI settles; blocking on a multi-minute poll inside this atomic stage is out of
  scope.

Which checks are *required* follows the repo's CI config (the `check` + `unit` jobs
always; the path-gated `integration` job when the diff touches its trigger paths). Trust
`gh pr checks` for the rollup rather than hard-coding the job list.

---

## Step 4 — Squash-merge

Every guard cleared: not a control-plane PR (Step 0), the required gates' latest verdicts
are PASS (Step 2), and checks are green (Step 3). Ship it with a squash merge so the issue's
whole branch collapses to one commit on `main`:

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

A single invocation ships one PR end to end: classify the diff against the control-plane
boundary and refuse if it touches one (Step 0, guard 0), resolve the PR ↔ issue (Step 1),
resolve the latest verdict per required gate namespace and merge only if every one is PASS
(Step 2, guard 1), confirm green checks (Step 3), squash-merge (Step 4), confirm the issue
closed (Step 5).

Report back a tight terminal ledger — nothing else, because the merge itself is the
durable record:

```
PR #<PR> — issue #<ISSUE>
branch: <head ref>
PR url: <html_url>
merged: yes | no (<reason if no>)
issue closed: yes | no
```

If you refused to merge, the reason line is the whole point: `blocking — manual merge`,
`unverified (no review-code PASS)`, `unverified (no review-doc PASS)`, `latest verdict is
FAIL (<gate>)`, `routed to heal-ci` (a red check, handed to the self-heal lane),
`checks pending`, or `no linked issue`. A refusal is a
successful run — shipping the wrong PR is the only failure mode that matters.

## Conventions

This skill is the terminal stage of a suite (`report` → `triage` → `plan-epic` →
`review-plan` → `write-code` → `review-code` / `review-doc` → **`ship-it`**) that turns GitHub issues into an
agent-operable pipeline. The shared label semantics and the body/comment/dependency/marker
formats live in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) — you are
the merge step named as the reader of format 5; the decision to give the pipeline a single
merge authority is ADR [0048](../../../.decisions/0048-ship-it-merge-actor.md), and the
control-plane boundary you enforce is ADR
[0053](../../../.decisions/0053-control-plane-boundary.md) (supersedes
[0049](../../../.decisions/0049-pipeline-ships-code-not-itself.md)). Your input is a
non-control-plane PR a gate signalled merge-ready; your output is a merged PR, a closed
issue, and a closed loop. You are the one stage with merge authority — guard it: never merge
a control-plane PR, and never merge on the absence of a failure, only on the presence of a
verified PASS.
