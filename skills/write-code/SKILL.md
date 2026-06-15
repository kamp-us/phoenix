---
name: write-code
description: Pick the next actionable issue off the configured target repo and execute it end to end — claim it by self-assigning, implement on a branch, open a PR that closes it, log progress on the issue, and hand off to the parent epic; OR, given a PR number, enter repair mode and consume a gate's latest FAIL verdict to fix-and-resubmit on the same branch. Trigger on "work the next issue", "pick up an issue", "implement issue #N", "run write-code", "do the next task", "/write-code", or whenever you're asked to turn triaged work into a PR; trigger repair mode on "repair PR #N", "fix the failed review on #N", "address the FAIL on PR #N". This is the execution stage of the issue-intake pipeline: it consumes `status:triaged` issues and produces PRs that `review-code`/`review-doc` gate, and it consumes those gates' FAIL markers to drive the fix round-trip.
---

# write-code

You are the executor. The backlog has already been triaged (`triage`) and any epic
has been planned into children with a dependency topology (`plan-epic`). Your job is
to take the **next actionable issue**, claim it, build it, and open a PR that closes
it — leaving a trail (progress comments, an epic handoff note) so the next agent picks
up cold without spelunking your head.

You operate **autonomously**. You don't propose-first or wait for sign-off on the pick
— triage already decided this work is worth doing and plan-epic already sequenced it.
Pick, claim, implement, hand off. The one gate downstream is `review-code`, which
verifies your PR against the issue's acceptance criteria before it merges; your job is
to make that verification pass, not to merge on your own authority.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
queries. Every issue/PR/label read and write goes through `gh api`. Branch, commit,
and PR-open go through `git` and `gh` per repo conventions. This is not a style
preference — GraphQL calls error out on this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## The formats contract

You **read three and write two** of the shared formats; read the contract before you
start: [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md).

- **`## Dependencies` grammar** (format 1) — you *read* it off a parent epic to derive
  whether a sub-issue is eligible (phase predecessors closed + every `requires: #N`
  closed). Blockedness is **derived from this section, never a label.**
- **Sub-issue body** (format 2) — you *read* it as your spec: `### What to build` is
  what to do, `### Acceptance criteria` is the contract `review-code` will verify, the
  `**TDD:**` flag is advice on whether to go test-first.
- **Progress comment** (format 3) — you *write* these on the issue you're working:
  Completed / Decisions / Gotchas / Next.
- **Epic handoff note** (format 4) — you *write* one on the parent epic when you
  finish a sub-issue: Done / Affects siblings / Watch out.

Read tolerantly (the formats are conventions, not parser specs — a synonym or a
slightly different bullet style still means what it means), write canonically.

---

## Invocation — two modes, disambiguated by what you're given

write-code has **two invocation shapes**, and the argument tells them apart:

- **A PR number → repair mode.** "Repair PR #N" / "fix the failed review on #N" hands you
  an *existing* PR. Go to [Repair mode](#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit):
  resolve the PR's latest gate verdict, and **only if** that latest verdict is FAIL, read
  the findings, fix them on the existing branch, push so the stateless gate re-runs, and
  stop. You do **not** pick new work, you do **not** branch, you do **not** merge.
- **An issue number, or no argument → initial-build mode.** "Implement #N" / "work the
  next issue" runs the normal **pick → claim → Steps 4–7** path below. This is unchanged.

The two are unambiguous: a PR number routes to repair, an issue number (or nothing) routes
to the pick-and-build path. If you're handed a bare number and genuinely can't tell which
it is, resolve it once — `gh api repos/$REPO/pulls/<N>` succeeds for a PR and
404s for a plain issue — and branch accordingly.

**The ownership boundary, stated once and load-bearing throughout:** **write-code owns
fail → fix → re-request; `ship-it` owns PASS → merge.** You own the branch and the PR, so
driving a FAIL'd PR back through the gate is your loop — but the merge is never yours, in
either mode (this mirrors the `gh-issue-intake-formats.md` §5/§6 relationship table, which
names write-code the consumer of *both* FAIL markers and `ship-it` the consumer of *both*
PASS markers).

---

## Step 1 — Pick the next issue

The pick rule is deterministic. Among **open** issues that are `status:triaged` **and
unassigned**:

1. **Highest priority bucket first:** all `p0` before any `p1`, all `p1` before any
   `p2`.
2. **Oldest first within a bucket:** lowest issue number / earliest `created_at`.

Assigned issues are someone else's claim — **skip them**. Skip on *any* non-null assignee,
not on an exact match: under the Step 3 claim race an issue may **transiently** show two
co-assignees for the window before the winner evicts the loser, and skipping any assigned
issue keeps that transient state safe — a half-resolved claim is never double-picked, it's
simply passed over until it settles to its single winner. `status:needs-triage`,
`status:needs-info`, and closed issues are not pickable (they haven't cleared triage).

### Pre-pick exception — resume your own failed PR first

The "skip assigned issues" rule has **exactly one exception**: a PR *you* opened that came
back FAIL. Its `Fixes #N` issue is still assigned to you (review-code/review-doc leave it
open and assigned on a FAIL), which would make it unpickable by the rule above — but that
arc is **yours to drive forward, not skip**. So **before** picking new `status:triaged`
work, scan your own open PRs for one whose **latest** gate verdict (in *either* namespace)
is an unaddressed FAIL:

```bash
ME=$(gh api user --jq '.login')
# open PRs you authored; print each one whose latest verdict in EITHER namespace is FAIL,
# UNLESS it has already hit the N=3 repair cap (then it's a human's, not yours to re-pick)
gh api "repos/$REPO/pulls?state=open&per_page=100" \
  --jq ".[] | select(.user.login==\"$ME\") | .number" | while read PR; do
  # whose markers count as a verdict — GitHub's repo ACL, the same trust root ship-it Step 2
  # uses (ADR 0055, supersedes 0051): build THIS PR's authorized set from its marker authors
  # holding write+ on the repo, so a forged review-(code|doc): FAIL from a non-reviewer can't
  # trigger spurious repair. Empty set ⇒ IN($authorized[]) matches nothing ⇒ no verdict
  # resolves ⇒ the scan safely finds nothing — fail-closed.
  comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
  # every marker test below is emphasis-tolerant (leading \** absorbs review-code's bolding)
  # per gh-issue-intake-formats.md §5 — the canonical matcher contract
  markerAuthors=$(jq -r '[.[]
      | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*(PASS|FAIL)"; "i"))
      | .user.login] | unique | .[]' <<<"$comments")
  authorized='[]'
  while IFS= read -r a; do
    [ -z "$a" ] && continue
    perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
    case "$perm" in
      admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
    esac
  done <<<"$markerAuthors"
  # FAIL rounds already accrued — per fix-round, not per marker (a both-namespace round counts once);
  # cluster by timestamp gap (>120s = new round), same identity as the Bounding count, never a minute bucket
  ROUNDS=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*FAIL"; "i"))
          | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
     | sort
     | reduce .[] as $t ({n:0, prev:null};
         if (.prev == null) or ($t - .prev) > 120
         then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
     | .n' <<<"$comments")
  [ "$ROUNDS" -ge 3 ] && continue   # at the cap → already escalated to a human, excluded from the scan
  CODE=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)"; "i"))]
     | sort_by(.created_at) | last | .body // ""' <<<"$comments")
  DOC=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
     | sort_by(.created_at) | last | .body // ""' <<<"$comments")
  echo "$CODE" | grep -qiE '^\s*\**\s*review-code:\s*FAIL' && echo "#$PR review-code FAIL"
  echo "$DOC"  | grep -qiE '^\s*\**\s*review-doc:\s*FAIL'  && echo "#$PR review-doc FAIL"
done
```

If such a PR exists, **repair it instead of picking new work** — go to
[Repair mode](#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit) with that PR
number. Only once you have **no** PR with an unaddressed latest FAIL do you fall through to
the normal pick below. (This scan is a coarse *signal* that deliberately matches the SHA-less
prefix; repair mode Step R1 re-resolves the verdict authoritatively per namespace **and
applies the SHA-staleness test** (ADR 0058) before acting, so a PR that flipped to PASS, or
whose FAIL is bound to a now-stale head, between the scan and the repair is a clean no-op.)

Two properties make this scan terminate rather than starve:

- **Author-gated verdicts (ADR [0055](../../../.decisions/0055-acl-sourced-review-authz.md)).**
  Markers count as a verdict **only from a `write+` repo collaborator** — the same GitHub-ACL
  gate `ship-it` Step 2 applies *before* the marker regex. A self-authored or
  forged `review-(code|doc): FAIL` is invisible here, so write-code can't pull *itself* into
  spurious repair (and a forged PASS can't mask a real FAIL).
- **Cap exclusion.** A PR already at the **N=3** cap is skipped (`ROUNDS >= 3 → continue`):
  escalation hands it to a human but leaves its latest verdict at FAIL, so without this skip
  the scan would re-match it forever — re-enter repair, recount 3 FAILs, re-escalate — and
  never advance to fresh work. Excluding capped PRs lets the picker step over the escalated
  PR and pick new `status:triaged` work.

List the candidate pool, priority bucket by priority bucket, stopping at the first
bucket that has any unassigned candidate:

```bash
# p0 first; only fall through to p1, then p2 if a bucket is empty of unassigned issues
for P in p0 p1 p2; do
  gh api "repos/$REPO/issues?state=open&labels=status:triaged,$P&sort=created&direction=asc&per_page=100" \
    --jq '.[] | select(.assignee == null and (.pull_request | not)) | "#\(.number)\t\(.created_at)\t\(.title)"'
done
```

`(.pull_request | not)` filters out PRs (the issues endpoint returns both). Take the
**first** unassigned issue in the **highest non-empty** bucket. That's your pick —
unless it's a sub-issue, in which case run the eligibility check in Step 2 first.

### Is it a sub-issue?

An issue may be a child of an epic. Check before claiming — a sub-issue carries
dependency constraints the bare issue doesn't show:

```bash
gh api repos/$REPO/issues/<N> --jq '.parent // "no parent (standalone)"'
```

If it has a `parent`, go to Step 2 to derive eligibility before claiming. If it's
standalone, skip to Step 3.

---

## Step 2 — Sub-issue eligibility (derive blockedness, never read a label)

For a sub-issue, **read the parent epic first** — its plan, its `## Dependencies`
topology, and its progress (the handoff-note comment stream). A child is only pickable
when its dependencies are all closed. There is **no `status:blocked` label**;
eligibility is computed fresh on every pick from the epic's `## Dependencies` section.

```bash
EPIC=<parent number>
# the epic body carries the plan + the ## Dependencies topology
gh api repos/$REPO/issues/$EPIC --jq '.body'
# the real child set + each child's state (the list endpoint is source of truth;
# sub_issues_summary undercounts under mixed closed/open children)
gh api "repos/$REPO/issues/$EPIC/sub_issues?per_page=100" \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
# the cross-task signal siblings left — read before assuming what's done
gh api "repos/$REPO/issues/$EPIC/comments?per_page=100" --jq '.[].body'
```

**The derivation rule** (from the formats `## Dependencies` grammar):

A child `#C` is **unblocked** iff:

- **Phase predecessors closed:** every issue in every phase *before* `#C`'s phase is
  closed. (Phases are the sequential spine — Phase 2 can't start until all of Phase 1
  is closed.) A child within a phase has no ordering against its phase-siblings.
- **`requires:` closed:** every issue named in `#C`'s `requires: #N, #M …` annotation
  is closed. This is the cross-boundary gate for a dependency that doesn't fall on a
  phase line.

Both conditions must hold. If either fails — a phase predecessor is open, or a
`requires:` target is open — the child is **blocked: skip it** and fall back to the
next pickable issue (the next unassigned `status:triaged` issue in priority/age
order, re-running Step 1 with this child excluded). Do **not** apply a label, do
**not** comment "blocked" — blockedness is a derived, transient fact, not a stored
state. The child becomes pickable the moment its blocker closes; on the next pick the
recomputation will let it through.

> Worked: epic with `### Phase 1: #210, #211` and `### Phase 2: #212 (requires: #210)`.
> If you're eyeing `#212`: it needs `#210` closed (its `requires:`). It does **not**
> need `#211` — `#211` is a phase-1 sibling but `#212` only gated on `#210`. Note the
> subtlety: `#212` is *in Phase 2*, so the phase-boundary rule would also gate it on
> all of Phase 1 — but a `requires:` that names a strict subset is the planner saying
> "this specific edge is what matters." When a `requires:` is present, honor it as the
> precise gate; when it's absent, fall back to the phase-boundary default. If a child
> in Phase 2 has no `requires:`, it waits on **all** of Phase 1.

---

## Step 3 — Claim by self-assigning (assign → observe-own-write → tiebreak)

Claiming is self-assignment, and it backs Step 1's "skip assigned issues" rule so other
write-code agents step over a claimed issue. But GitHub's `assignees` is **last-write-wins
and additive, not compare-and-swap**: a bare `POST` self → re-read does **not** lock. Two
agents that both saw #N unassigned in Step 1 both `POST` themselves seconds apart,
co-assigning `[A, B]`, and a best-effort re-read only catches whichever agent happens to
read *after* the other's write lands — the window between the two `POST`s lets both pass and
both implement #N. That is the TOCTOU this step closes (#260).

The fix uses the **one atomic signal GitHub does give us**: the assignee `POST` **returns
the updated issue with the full `assignees` array** — your own write's observed result, not
a separate best-effort re-read that can miss the window. So you detect a concurrent claim
from your *own* `POST` response, and break the tie **deterministically** so exactly one of
two co-assignees proceeds:

```bash
ME=$(gh api user --jq '.login')

# Best-effort fast-path, NOT the lock: a cheap re-read at claim time that lets the common case
# (#N already owned by a prior winner) back off without needlessly evicting them. It is itself a
# best-effort read — a co-racer's POST can land in the gap between this read and my own POST, so an
# empty PRE does NOT prove I'm unraced. The sole resolver remains the checkpoint GET below; PRE
# only spares an already-settled owner an eviction it doesn't deserve.
PRE=$(gh api repos/$REPO/issues/<N> --jq '[.assignees[].login] | sort | join(" ")')
if [ -n "$PRE" ]; then
  # Already owned before I touched it — never evict a pre-existing owner. Back off, re-pick.
  exit 0  # → re-run Step 1
fi

# POST self; capture the FULL assignees list the write returns (single observable write).
ASSIGNEES=$(gh api -X POST repos/$REPO/issues/<N>/assignees \
  -f "assignees[]=$ME" --jq '[.assignees[].login] | sort | join(" ")')

# Provisional tiebreak among co-racers: min-login. NOTE the POST echo is NOT a snapshot both
# racers share — it returns only the assignees present when THIS POST was processed, so staggered
# POSTs see DIFFERENT sets: if B lands first it sees [B] (B believes it won), and A's later POST
# sees [A, B] (A also believes it won). Both can transiently compute themselves winner here. The
# echo alone does NOT decide the race — it only flags "I may be a co-racer winner; go evict + verify".
WINNER=$(printf '%s\n' $ASSIGNEES | head -n1)
if [ "$WINNER" = "$ME" ]; then
  # I am a provisional winner. Evict the co-assignees so the issue reads single-owner for the
  # picker's "skip assigned" invariant.
  for a in $ASSIGNEES; do
    [ "$a" = "$ME" ] && continue
    gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$a"
  done
  # CHECKPOINT — THIS is what resolves the race, not the POST echo. Re-read canonical issue state
  # (a fresh GET, not the stale POST echo) and re-confirm I am still min(assignees). Required for
  # ordinary co-racer correctness, not just for late stragglers: in the staggered case B saw [B]
  # and entered here as a false winner; A (min) evicted B, so B's GET re-reads [A], CUR_MIN==A!=B,
  # and B aborts. The agent whose GET shows min==ME proceeds; any agent evicted out of min aborts.
  # Do NOT prune this as redundant — without it both staggered co-racers proceed (double-pick).
  STILL=$(gh api repos/$REPO/issues/<N> --jq '[.assignees[].login] | sort | join(" ")')
  CUR_MIN=$(printf '%s\n' $STILL | head -n1)
  # Displaced at the checkpoint → self-clean before backing off, exactly like the loser
  # branch. Every non-winner removes itself; back-off never leaves a stale self-assignment
  # for another agent's eviction loop to clean up (which would widen the transient window).
  [ "$CUR_MIN" = "$ME" ] || { gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME"; exit 0; }
  # claim won and confirmed — proceed to implement
else
  # I lost the tiebreak: remove myself and re-pick (do NOT implement — do NOT co-occupy).
  gh api -X DELETE repos/$REPO/issues/<N>/assignees -f "assignees[]=$ME"
  # back off → re-run Step 1, pick the next issue
fi
```

**The operating rule.** The min-login among co-racers is **provisional** — the `POST` echo only
*detects* that you may be racing, it does not *resolve* the race. The sole resolver is the
post-eviction **checkpoint GET** of canonical issue state: keep it, never prune it as "redundant"
(without it both staggered co-racers proceed — a double-pick). The residual is the transient
2-assignee window before an eviction lands; Step 1 tolerates it by skipping on **any** non-null
assignee, so it's passed over, never double-picked. This is a **detect-and-tiebreak, not a
lock** — don't reintroduce the "it's the lock" framing.

See [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7 for the full race-case
derivation — the staggered-co-racer walkthrough (B echoes `[B]`, A echoes `[A, B]`, the checkpoint
GET resolves), the straggler, the transient window, and why it's detect-and-tiebreak, not a kernel
mutex — and the shared claim semantics this step implements.

Now **route by type** before implementing — a `type:decision` or `type:investigation`
issue is not a "write code and open a PR" issue. See [Type routing](#type-routing)
and branch there if the issue carries one of those types. Everything else
(`type:feature`, `type:chore`, `type:bug`) is the implement-and-PR path below.

---

## Step 4 — Implement on a branch

write-code **MUST run in an isolated git worktree** — when spawned as a subagent, via
the Agent tool's `isolation: worktree`. The operator loop requires it so concurrent
runs can't race or dirty the primary checkout. This constrains how you branch: `main`
is already checked out in the primary tree, so `git checkout main` **fails** inside an
isolated worktree (`fatal: 'main' is already checked out at <primary>`). Branch from
latest origin `main` **without checking it out**:

```bash
git fetch origin main
# Per-run suffix: the deterministic <prefix>/<slug-for-issue-N> is the SAME ref for every
# run on this issue, so two concurrent runs would both push origin/<that branch> and the
# second push would clobber the first's commits. A per-invocation nonce keeps them distinct.
BRANCH="<prefix>/<slug-for-issue-N>-$(uuidgen | head -c 8)"
git switch -c "$BRANCH" FETCH_HEAD
```

It's `git switch -c "$BRANCH" FETCH_HEAD` (not `git checkout main`) on purpose: in an
isolated worktree `main` is checked out elsewhere, so branching directly off the
freshly-fetched `FETCH_HEAD` is the only flow that works — don't "fix" it back to a
`main` checkout.

Use your git convention — `<prefix>` is your personal branch prefix, like `umut/` — with
a short kebab-case slug naming the work, and the per-run nonce appended so two concurrent
runs on the same issue never push the same `origin/` ref. Read the issue's `### What to build` for scope
and honor the `**TDD:**` flag — `yes` means write the failing test first, then make it
pass; `no` means config/docs/scaffolding where test-first doesn't apply.

> **Non-isolated fallback.** For the rare invocation that isn't already in a worktree,
> spin one up rather than checking out `main`. Carry the same per-run `$BRANCH` (nonce and
> all) and a per-run worktree path so two concurrent fallback runs collide on neither the
> branch nor the dir: `WT="../wt-issue-<N>-$(uuidgen | head -c 8)"; git worktree add -b
> "$BRANCH" "$WT" origin/main`, then `cd "$WT"`. When you're done, remove it with
> `git worktree remove "$WT"`.

Ground the implementation in the codebase the way the repo expects: the ADRs in
`.decisions/` are the *why* and the binding decisions, the patterns in `.patterns/`
are *how the current code is shaped* — read the relevant ones before writing, and
follow them over intuition (per `CLAUDE.md`). Implement the issue's acceptance
criteria; they are the literal checklist `review-code` will verify, so build to make
every box checkable from the outside. Run `pnpm typecheck` and the test suite as the
repo conventions require before you open the PR.

For **lint**, do **not** run `pnpm lint` (`biome check .`) from inside the worktree:
bare `.` resolves to the worktree's own CWD, which physically sits under
`.claude/worktrees/<id>` and so matches the retained `!**/.claude/worktrees`
exclusion — biome reports "0 files / paths ignored" and exits **0 without linting
anything** (a false green; #236, [ADR 0060](../../../.decisions/0060-worktree-lint-changed-paths.md)).
Lint **explicit paths** instead — the changed files biome handles, never bare `.`.
Filter the changed set to biome-handled extensions so a docs/markdown-only PR (no
`.ts`/`.tsx`/`.json`/… in the diff) is a **clean skip (exit 0)**, not a false-fail:
on biome 2.4.15 an all-unknown/ignored path set still exits **1** ("No files were
processed"), and `--files-ignore-unknown=true` does *not* rescue an entirely-unknown
set — so the filter, not the flag, is what keeps docs-only green (#236,
[ADR 0060](../../../.decisions/0060-worktree-lint-changed-paths.md)):

```bash
CHANGED="$(git diff --name-only --diff-filter=ACMR origin/main...HEAD \
  | grep -Ev '^node_modules/' \
  | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css|graphql)$' || true)"
if [ -n "$CHANGED" ]; then
  pnpm exec biome check --files-ignore-unknown=true $CHANGED
else
  echo "no biome-handled changed files to lint"   # docs-only / empty diff: clean skip, never bare `biome check .`
fi
```

Commit per repo conventions. Don't push to or PR from `main`.

---

## Step 5 — Open a PR that closes the issue

Open the PR with **`Fixes #N` in the body** so merging auto-closes the issue (this is
the seam `review-code` relies on: pass → merge → `Fixes #N` closes it). Use the issue
number you're implementing.

```bash
git push -u origin "$BRANCH"   # the same per-run branch you created in Step 4
gh pr create \
  --base main \
  --title "<concise PR title>" \
  --body "$(cat <<'EOF'
<short summary of what changed and why>

Fixes #<N>
EOF
)"
```

> `gh pr edit` is unreliable in this org (Projects-classic). If you must edit a PR
> after creation, patch via REST: `gh api -X PATCH repos/$REPO/pulls/<PR>
> -f body="…"`. Get the PR body right at `create` time and you won't need it.

Confirm the linkage landed — once `Fixes #N` is in the body, the issue's timeline
records a `cross-referenced` / `connected` event for the PR. Verify via REST:

```bash
gh api repos/$REPO/issues/<N>/timeline \
  --jq '.[] | select(.event == "cross-referenced" or .event == "connected") | .event'
```

---

## Step 6 — Log progress on the issue

Throughout the work, and at minimum when you open the PR, post a **progress comment**
on the issue you're working in the format-3 shape (Completed / Decisions / Gotchas /
Next — see [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §3). This
is the per-issue ledger for the next agent (a successor write-code run, or
`review-code`): what moved, what you decided and why, what bit, what's still open.

```bash
BODY="$(cat /tmp/write-code-progress.md)"   # the four-section comment
gh api repos/$REPO/issues/<N>/comments -f body="$BODY"
```

Assemble the comment from a temp file so multi-line markdown and backticks survive the
shell. Keep it scannable — bullets over paragraphs, omit a heading with nothing under
it. Record decisions at the point you make them, not retroactively.

---

## Step 7 — Hand off to the parent epic (sub-issues only)

When you finish a **sub-issue** (PR open, work done), post a distilled **handoff note**
as a comment **on the parent epic** in the format-4 shape (Done / Affects siblings /
Watch out — see [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §4).
The epic's comment stream is the agent-to-agent relay: this is the coarse cross-task
signal a sibling reads *instead of* spelunking your child issue.

```bash
BODY="$(cat /tmp/write-code-handoff.md)"   # ### Handoff: #N — <title> + the three fields
gh api repos/$REPO/issues/<EPIC>/comments -f body="$BODY"
```

Distill, don't dump — the fine detail lives in the child's progress comments and PR.
**"Affects siblings" is the load-bearing field:** if finishing this child changed what
a later phase should do (a new module, a changed contract, a decision recorded), say
so — that's the context the `## Dependencies` graph routes along. If the child finished
in pure isolation with zero sibling impact, a one-line "Done" handoff is honest and
complete; don't manufacture cross-task context that isn't there.

A standalone (non-sub-issue) issue has no parent epic — skip this step.

---

## Repair mode — consume a gate FAIL verdict, fix-and-resubmit

This is the second invocation shape: keyed off a **PR number**, it is the consumer the
gate FAIL markers were written for (`gh-issue-intake-formats.md` §5/§6 name write-code the
reader of both `review-code: FAIL @ <sha> — not merge-ready` and `review-doc: FAIL @ <sha> —
changes-requested`, SHA-bound per ADR 0058). You take a PR that came back failed, apply exactly the enumerated
findings on the **same branch**, push so the **stateless** gate re-runs, and stop. Steps
1–7 above are the *initial* build; this is everything that happens *after* a gate FAIL.

### Why the author may fix its own FAIL'd PR (this is not a firewall violation)

The bias firewall lives at the **review step, not the fix step.** The FAIL came from an
**independent** reviewer, and an **independent re-review re-gates** the fix statelessly.
write-code re-editing its own branch is sound *precisely because it cannot self-approve* —
it never writes a PASS marker, never merges, and the gate re-runs and re-judges the new
commits with fresh eyes. So repair mode does **not** spawn a distinct fixer; the author
fixing its own PR and an independent gate re-judging it is the firewall, intact.

### Step R1 — Resolve the latest verdict per namespace (mirror `ship-it` Step 2)

Do **not** act on the presence of any FAIL that ever existed. Resolve `review-code` and
`review-doc` in **separate namespaces** — two anchored regexes that never cross-match —
and take the **latest by timestamp** in each. This mirrors `ship-it` Step 2's resolution
exactly (the reading side of the same contract), **including its ACL author-gate**:
a marker comment counts as a verdict only from a `write+` repo collaborator, so a
self-authored or forged `review-(code|doc): FAIL` is invisible (ADR
[0055](../../../.decisions/0055-acl-sourced-review-authz.md)). The native-review path needs
no ACL gate — GitHub author-attributes reviews, so it is unforgeable.

```bash
PR=<the PR number you were handed>
# whose markers count as a verdict — GitHub's repo ACL, the same trust root ship-it Step 2 uses
# (ADR 0055): build the authorized set from THIS PR's marker authors holding write+ on the repo.
comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
# every marker test below is emphasis-tolerant (leading \** absorbs review-code's bolding)
# per gh-issue-intake-formats.md §5 — the canonical matcher contract
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' <<<"$comments")
authorized='[]'
while IFS= read -r a; do
  [ -z "$a" ] && continue
  perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
  case "$perm" in
    admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
  esac
done <<<"$markerAuthors"

# the PR's CURRENT head SHA — the head every verdict must be bound to (ADR 0058)
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"

# latest review-code marker (code namespace) — author-gated, anchored, never matches review-doc.
# Capture the bound head SHA from the @ <sha> tail (sha=null for a pre-0058 SHA-less marker).
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' <<<"$comments"

# latest decisive native review (APPROVED / CHANGES_REQUESTED) — folds into the code namespace
# (no ACL gate: GitHub author-attributes reviews, so this path is unforgeable). commit_id IS its bound SHA.
gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}'

# latest review-doc marker (doc namespace) — author-gated, anchored, never matches review-code
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' <<<"$comments"
```

Resolve per namespace, latest-wins by timestamp, **then apply the SHA-staleness test** (ADR
[0058](../../../.decisions/0058-sha-bound-verdict-contract.md), mirroring `ship-it` Step 2b):

- **review-code namespace** — the verdict is the **newest of {latest decisive review,
  latest review-code marker}**; its bound SHA is the marker's `@ <sha>` (or the review's
  `commit_id`). `CHANGES_REQUESTED` or `review-code: FAIL` is FAIL; `APPROVED` or
  `review-code: PASS` is PASS.
- **review-doc namespace** — the verdict is the **latest `review-doc` marker** by
  `created_at` (review-doc is comment-only — no native review). `review-doc: FAIL` is FAIL.

**Act only when a namespace's latest verdict is FAIL *bound to the current head*.** A newer
FAIL is acted on even if an older PASS exists — but a FAIL whose `@ <sha>` is **not** the PR's
current head (`$CURRENT_HEAD`, by prefix-match either way), or that carries **no** `@ <sha>`
(a pre-0058 legacy marker), is **stale**: it judges code that has since changed, so do **not**
repair on it — report `nothing to repair (latest FAIL not bound to current head)` and stop.
A PR whose latest current-head verdict is PASS — or that has no current-head FAIL at all — is
**not repaired**. This keeps repair mode **idempotent**: re-running it on an already-fixed/PASS
PR, a no-FAIL PR, or a stale-FAIL PR is a clean no-op. If **both** namespaces' latest
current-head verdicts are FAIL (a mixed code+doc PR), address **both** in this round.

### Step R2 — Read the enumerated findings, fix exactly those

The FAIL marker comment (or `CHANGES_REQUESTED` review body) carries a **per-criterion
evidence table** — each unmet `### Acceptance criterion` (and, for `review-doc`, each unmet
hygiene check) listed as a `[FAIL]`/`[UNVERIFIABLE]` line with what's missing. Read the
full body of the resolving comment/review and treat **those enumerated findings as your
work list** — fix exactly what they name, no more, no less:

```bash
# the full body of the latest FAILing review-code marker (swap review-code→review-doc for the doc namespace)
# author-gated against the ACL-derived $authorized set R1 already built — only a real reviewer's findings are your work list
# marker test stays emphasis-tolerant (leading \** absorbs review-code's bolding) per gh-issue-intake-formats.md §5
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-code:\\s*FAIL"; "i"))]
    | sort_by(.created_at) | last | .body' <<<"$comments"
```

For context on *what the PR was supposed to do*, resolve the **linked issue** via the PR
body's `Fixes #N` and re-read its `### Acceptance criteria` (the same checklist the gate
verified) and the progress trail:

```bash
N=$(gh api repos/$REPO/pulls/$PR \
  --jq '.body | capture("(?i)\\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\\s+#(?<n>[0-9]+)") | .n')
gh api repos/$REPO/issues/$N --jq '.body'
gh api "repos/$REPO/issues/$N/comments?per_page=100" --jq '.[].body'
```

Check out the **existing PR branch** and fix on it — **no new branch** (a new branch would
orphan the PR and the gate's history):

```bash
git fetch origin
git switch <the PR's head branch>     # gh api .../pulls/$PR --jq '.head.ref'
# apply the fixes addressing exactly the enumerated findings
```

Ground the fixes the same way the initial build does — ADRs in `.decisions/` for the *why*,
patterns in `.patterns/` for *how the code is shaped* — and run `pnpm typecheck` / the test
suite plus the **explicit-paths lint** from Step 4 (never `pnpm lint` / `biome check .`,
which self-no-ops from inside a worktree — #236) before pushing, exactly as Step 4 requires.

### Step R3 — Push, post a progress comment, then stop (the gate re-runs)

Push the fix to the same branch and post a **format-3 progress comment** on the linked
issue (Completed = the findings you addressed; Decisions/Gotchas; Next = "re-review
requested"). Pushing new commits is what makes the **stateless** gate re-run — you do
**not** re-trigger or self-approve it:

```bash
git push origin HEAD
gh api repos/$REPO/issues/$N/comments -f body="$(cat /tmp/write-code-repair-progress.md)"
```

Then **stop.** The independent re-review re-gates the fix and lands a fresh verdict; that
is the firewall. write-code does **not** write a PASS marker, does **not** approve, and
does **not** merge — merge is `ship-it`'s sole authority (and for a control-plane
`.claude`/`.github` PR, a *human's*; see the guardrail below). Report which findings you
addressed and that you handed the PR back to the gate.

### Bounding — cap at 3 rounds, then escalate

Repair is **bounded at N = 3** fix → re-review rounds on the same PR, to avoid looping
forever on a finding it cannot resolve. Count your rounds from the PR's history — a "round"
is one (gate FAIL → your fix-push) pair. Count **rounds, not markers**: a mixed code+doc PR
that FAILs in *both* namespaces in the same review pass is **one** round, not two. Identify
a review pass by **timestamp adjacency, not a wall-clock bucket**: cluster the FAIL markers
and start a new round only when the gap to the previous FAIL exceeds a threshold (`120s`
below). The two markers of one code+doc pass land seconds apart (back-to-back `gh api`
posts) so they cluster into one round regardless of which side of a minute boundary they
fall on; two *genuine* rounds are always separated by your fix-push + an independent
re-review (minutes at least), so they never collapse into one. (A fixed `created_at[:16]`
minute bucket gets both of these wrong: it splits one pass straddling `:59`/`:00` into two
rounds — premature escalation — and merges two real rounds that share a minute into one —
the cap fails to bind and the loop runs past N=3.) Same ACL author-gate as Step
R1 (reuse its `$comments` + `$authorized`) — only a real reviewer's FAIL counts toward the cap:

```bash
# how many distinct gate-FAIL ROUNDS has this PR already accrued (both namespaces)?
# cluster FAIL markers by timestamp gap: a new round starts only when >120s separates two
# FAILs, so a code+doc pass (seconds apart) is one round and two real rounds (fix-push +
# re-review apart) are two — grid-free, so no minute-boundary split or same-minute merge.
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*FAIL"; "i"))
         | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
    | sort
    | reduce .[] as $t ({n:0, prev:null};
        if (.prev == null) or ($t - .prev) > 120
        then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
    | .n' <<<"$comments"
```

If this PR has **already had 3 FAIL→fix rounds** (you'd be pushing a 4th fix against a 4th
FAIL), **stop fixing and escalate** instead of pushing again:

```bash
gh api repos/$REPO/issues/$N/comments -f body="$(cat <<'EOF'
### Repair escalation — PR #<PR> still FAILing after 3 rounds

This PR has reached the N=3 repair cap with the gate still requesting changes. Handing
back to a human rather than looping. Still-failing criteria:

- <criterion> — <what the gate keeps flagging>

Needs a human decision (the finding may be unresolvable as scoped, or the AC needs
revisiting).
EOF
)"
# surface it for a human / re-triage rather than re-pushing
gh api -X POST repos/$REPO/issues/$N/labels -f "labels[]=status:needs-triage"
```

Escalation **stops the loop** — name the still-failing criteria, hand the PR back to a
human, and surface the issue for re-triage. Do **not** push a 4th fix. Escalation does
**not** flip the PR's latest verdict (it stays FAIL — only an independent re-review can
PASS it), so the loop closes on the *picker* side: the pre-pick scan (Step 1) excludes any
PR already at the cap (`ROUNDS >= 3`), so a future write-code run steps over this escalated
PR and picks new `status:triaged` work instead of re-entering repair and re-escalating it
forever. The cap thus terminates **both** the fix loop *and* the re-selection loop.

### Guardrails (repair mode)

- **Never merge.** Repair mode pushes and hands back to the gate; the merge is `ship-it`'s
  (PASS → merge), and for a control-plane `.claude`/`.github` PR a **human's** — `ship-it`
  *refuses* to auto-merge blocking-set PRs and `review-doc` is advisory-only on them (ADR
  [0053](../../../.decisions/0053-control-plane-boundary.md)). **This very edit is such a PR:
  a `.claude/**` change `ship-it` will refuse to auto-merge, merged by hand.** Repair mode
  never weakens that refusal.
- **Same branch, never a new one.** Fix on the PR's existing head branch so the PR and its
  gate history stay intact.
- **Idempotent.** Re-running on an already-fixed / PASS PR (one with no latest FAIL, or one
  whose latest FAIL is bound to a now-stale head) is a clean no-op (Step R1).
- **SHA-bound verdicts (ADR [0058](../../../.decisions/0058-sha-bound-verdict-contract.md)).**
  Act only on a FAIL bound to the PR's **current head** — a FAIL whose `@ <sha>` is stale (or
  absent) judges code that has since changed, so repair mode ignores it. This mirrors
  `ship-it` Step 2b's staleness refusal on the reading side.
- **Both namespaces.** Handle `review-code: FAIL @ <sha>` (§5) **and** `review-doc: FAIL @ <sha>`
  (§6) — latest current-head verdict per namespace — not just `review-code`.
- **Author-gated verdicts.** A marker counts only from a `write+` repo collaborator —
  the same GitHub-ACL gate `ship-it` Step 2 applies before the marker regex, so a forged or
  self-authored `review-(code|doc): FAIL`/`PASS` can neither trigger spurious repair nor
  mask a real verdict (ADR [0055](../../../.decisions/0055-acl-sourced-review-authz.md)).
- **Bounded *and* non-starving.** The N=3 cap stops the fix loop; the pre-pick scan's
  cap-exclusion (`ROUNDS >= 3`) stops the re-selection loop, so an escalated PR never
  re-pulls a future run into repair (Step 1, Bounding).
- **`gh api` REST / porcelain only**, never GraphQL (same reason as everywhere in this
  skill — the org's Projects-classic integration breaks GraphQL).

---

## Type routing

Three of the six types are "implement and open a PR" work: `type:feature`,
`type:chore`, `type:bug` follow Steps 4–7 as written. The other two settle
differently — there's no feature branch to merge, so the closing artifact is a record,
not a PR.

### `type:decision`

A decision issue asks for a settled, recorded technical choice — not code. Resolve it,
then **record it via the in-repo `/adr` skill** (at `.claude/skills/adr/SKILL.md` —
read it): it writes one decision per file into `.decisions/NNNN-slug.md` (Context /
Decision / Consequences), appends a row to `.decisions/index.md`, and follows the
supersede rules for any ADR it replaces. The ADR file + index row land on a branch and
go in via a PR the same as code (so `review-code` can still gate it).

Then close the loop on the issue:

- Post a progress/closing comment (format 3) stating the decision and **linking the
  ADR** (`.decisions/NNNN-slug.md`).
- Put `Fixes #N` in the PR that adds the ADR, so merging the ADR closes the decision
  issue.
- If it's a sub-issue, the handoff note (Step 7) records the decision as "Affects
  siblings" — a recorded decision is exactly the kind of cross-task signal later phases
  need.

A decision that's genuinely "just a convention" with no `.decisions/` weight is still
recorded — the `/adr` skill's bar is "a meaningful technical preference future agents
should respect," which a `type:decision` issue is by definition.

### `type:investigation`

An investigation issue asks "what's going on / is this real / what's the cause" — the
deliverable is a **diagnosis**, and then *routing* its findings, not a feature branch.

1. **Post the diagnosis as the closing comment** on the issue: what you found, the
   root cause (or "could not reproduce" / "not a real problem" with the evidence), and
   the verdict. This comment *is* the close — investigations don't merge a PR to close;
   they close because the question is answered. Close it:

   ```bash
   gh api repos/$REPO/issues/<N>/comments -f body="$DIAGNOSIS"
   gh api -X PATCH repos/$REPO/issues/<N> -f state=closed -f state_reason=completed
   ```

   (`completed`, not `not_planned` — the investigation *did its job*. Reserve
   `not_planned` for work that won't be done.)

2. **File actionable residue as new issues via the [`report`](../report/SKILL.md)
   skill.** An investigation usually turns up follow-up work — a bug to fix, a refactor,
   a missing test. Each such item is a *new* report-style issue (the report skill's
   5-section type-blind template + `status:needs-triage`), so it re-enters the pipeline
   at intake and gets triaged on its own merits. Don't pre-type or pre-prioritize the
   residue — that's triage's call, same as any report. Cross-link: mention the
   investigation issue number in the report's Pointers section.

3. **Route durable knowledge to `.decisions/` / `.patterns/`.** If the investigation
   established something that should bind future agents — a decision, that goes through
   `/adr` (a `.decisions/` ADR); a pattern about how the code is/should-be shaped, that
   goes to `.patterns/` (add or extend a doc per the `.patterns/index.md` criteria).
   Durable knowledge belongs in the repo's doc surfaces, not buried in a closed issue's
   comment thread. (The diagnosis comment can *link* to the ADR/pattern it produced.)

If the investigation is a sub-issue, still post the handoff note (Step 7): "Done: cause
X confirmed / ruled out; Affects siblings: filed #A, #B as residue, recorded ADR
NNNN."

---

## Running it

A single invocation does one unit of work end to end, in one of the two modes:

- **Initial build** (issue number / no arg): pick (Step 1 — including the pre-pick
  resume-my-failed-PR scan — +Step 2 if a sub-issue), claim (Step 3), then either
  implement→PR→progress→handoff (Steps 4–7) or the type-routed path. Report a short
  ledger: the issue picked (and why — bucket + age, or the sub-issue eligibility
  derivation), the branch and PR opened (or the ADR/diagnosis for a
  decision/investigation), and a pointer to the progress comment.
- **Repair** (PR number): resolve the PR's latest verdict per namespace (Step R1) and, if
  it's FAIL, fix the enumerated findings on the same branch, push, post progress, and stop
  (Steps R1–R3) — or escalate if the PR has hit the N=3 cap. Report which findings you
  addressed (or `nothing to repair` for a PASS/no-FAIL PR), and that you handed the PR back
  to the gate. **Never merge** in either mode.

Don't narrate every REST call — the assignee, the comments, and the PR are the durable
record.

To sweep, re-invoke: each run re-derives state fresh — the next pick (including sub-issue
eligibility, which moves as blockers close) *and* whether you own a FAIL'd PR to resume
first — so the loop is stateless and always does the right next thing.

## Conventions

This skill is one of a suite (`report` → `triage` → `plan-epic` → `review-plan` →
**`write-code`** → `review-code` → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). Your input is the
`status:triaged` issues that `triage` produced (standalone) or that `review-plan` flipped
from `status:planned` after gating a `plan-epic` ledger (epic children — ADR
[0047](../../.decisions/0047-review-plan-gate.md)); your output —
a claimed issue, a PR with `Fixes #N`, progress comments, and an epic handoff note — is
exactly what `review-code`/`review-doc` read to verify the work against its acceptance
criteria before merge. The loop closes back on you: when a gate lands a **FAIL** marker
(`review-code` §5 or `review-doc` §6), *you* are its consumer — [Repair mode](#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit)
reads the findings, fixes, and re-submits for an independent re-gate, while `ship-it` stays
the sole owner of PASS → merge. You also lean on two sibling skills inside type routing:
`/adr`
(`.claude/skills/adr/`) for `type:decision`, and [`report`](../report/SKILL.md) for an
investigation's actionable residue.
