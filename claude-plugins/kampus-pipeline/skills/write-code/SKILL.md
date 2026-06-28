---
name: write-code
description: Pick the next actionable issue off the configured target repo and execute it end to end — claim it by self-assigning, implement on a branch, open a PR that closes it, log progress on the issue, and hand off to the parent epic; OR, given a PR number, enter repair mode and consume a gate's latest FAIL verdict to fix-and-resubmit on the same branch. Trigger on "work the next issue", "pick up an issue", "implement issue #N", "run write-code", "do the next task", "/write-code", or whenever you're asked to turn triaged work into a PR; trigger repair mode on "repair PR #N", "fix the failed review on #N", "address the FAIL on PR #N". This is the execution stage of the issue-intake pipeline: it consumes `status:triaged` issues and produces PRs that `review-code`/`review-doc`/`review-skill` gate, and it consumes those gates' FAIL markers to drive the fix round-trip.
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

**You are the implementer, never the reviewer of your own diff (the split-role firewall).**
The whole point of the pipeline is split-role review — implementer ≠ reviewer — so the
self-evaluation bias of grading your own work never enters the merge decision. That guard
lives in *who runs the gate*, and it is **structural, not advisory**: write-code **never
invokes `review-code`/`review-doc`/`review-skill` on the PR it just opened or repaired**, and
**never posts a `review-(code|doc|skill): PASS`/`FAIL` marker** on its own output. The gate is
run by a **separate** reviewer agent; you **hard-stop** at PR-open (initial mode) and after
resubmit (repair mode) and leave the verdict to them. Re-reading your own diff to *self-check
before you push* is fine — what's forbidden is **stepping into the gate role**: running a
review skill on your PR, or emitting a verdict marker. Repair mode's loop is sound for the same
reason — you fix, an **independent** re-review re-gates; you never write the PASS (see
[Why the author may fix its own FAIL'd PR](#why-the-author-may-fix-its-own-faild-pr-this-is-not-a-firewall-violation)).
This invariant is the skill's own rule, enforced here — **it does not rely on a per-spawn
hand-off instruction** (which agents demonstrably ignored, walking themselves into the gate on
their own PR — #664).

## All GitHub ops via `gh api` REST — never GraphQL

Every issue/PR/label read and write goes through `gh api` — the org's legacy
Projects-classic integration errors out GraphQL issue queries, so this is a hard
constraint, not a style call (branch/commit/PR-open use `git`/`gh` per repo conventions).
Resolve the target repo once, up front (this skill is repo-agnostic — every call targets
`$REPO`); the full resolution rule is the shared contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), ADR 0062 §1), defaulting
to `kamp-us/phoenix` with no config.

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

## The glossary — read `.glossary/`, use the canonical terms

Before you draft a PR title/body, a progress comment, an epic handoff, or any identifier
you introduce, read the repo-owned vocabulary register and reach for its names rather than
inventing your own (the one-concept-named-four-ways drift, #851; ADR 0099):
[`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)
(domain nouns) and [`.glossary/LANGUAGE.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/LANGUAGE.md)
(architecture vocabulary) — the single source; never copy a definition into this skill.

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
either mode (this mirrors the `gh-issue-intake-formats.md` §5/§6/§6.5 relationship table, which
names write-code the consumer of *all three* FAIL markers and `ship-it` the consumer of *all
three* PASS markers).

### A rebase invalidates the PASS — rebase → re-review → ship is atomic

Whenever a PR head moves after it was reviewed — most often **a rebase to catch up to
`main`**, but any force-push — the prior `review-code`/`review-doc`/`review-skill` PASS is bound
to the *old* head and is **staleness-invalidated** (ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)): the verdict attests the exact
tree it reviewed, and the rebased head is, in principle, un-reviewed. `ship-it` will then
correctly refuse with `unverified (verdict not bound to current head)` (its Step 2b). That
refusal is **the system working, not a stall** — never weaken the SHA-binding to route around
it, and never wait on a human for it.

So a rebase is never the *last* step before ship. **Rebase → re-review → ship is one atomic
sequence:** after you rebase (or force-push) a PR, the new head needs a **fresh review against
that head** before `ship-it` can act — re-run the matching gate (`review-code` for code,
`review-doc` for docs, `review-skill` for skills) against the new head, and only once its latest
verdict is a current-head PASS hand off to `ship-it`. Never ship on a **pre-rebase PASS** — the rebase invalidated it the
moment it landed, so "ship on the existing PASS after a rebase" is self-contradictory.

The pattern that **never hits this**: **review the exact head you ship.** A flow that reviews
and ships in one pass over a single head never orphans its verdict; the split
review-then-rebase-then-ship flow is the only one that does, and the fresh re-review is what
re-binds the verdict to the head being merged (#310).

---

## Step 1 — Pick the next issue

The pick rule is deterministic. Among **open** issues that are `status:triaged` **and
unassigned**:

1. **Highest priority bucket first:** all `p0` before any `p1`, all `p1` before any
   `p2`.
2. **Milestone tiebreaker *within* a bucket:** among equal-priority candidates, prefer
   one in the **active milestone** — *never* across buckets.
3. **Oldest first** otherwise: lowest issue number / earliest `created_at`.

**The priority spine is sovereign — p0 outranks any milestone lean.** Milestone only
reorders *within* a single priority bucket; it never reaches across one. A p0 outside the
active milestone is therefore always picked before a lower-priority issue inside it — the
campaign bias is a *tiebreaker*, not a new top-level sort key. See
[Milestone-aware ordering](#milestone-aware-ordering) for the full rule, including the
explicit `work milestone N` mode and why p0-sovereignty holds in both modes.

Assigned issues are someone else's claim — **skip them**. Skip on *any* non-null assignee,
not on an exact match: under the Step 3 claim race an issue may **transiently** show two
co-assignees for the window before the winner evicts the loser, and skipping any assigned
issue keeps that transient state safe — a half-resolved claim is never double-picked, it's
simply passed over until it settles to its single winner. `status:needs-triage`,
`status:needs-info`, and closed issues are not pickable (they haven't cleared triage).

### Pre-pick exception — resume your own failed PR first

The "skip assigned issues" rule has **exactly one exception**: a PR *you* opened that came
back FAIL. Its `Fixes #N` issue is still assigned to you (review-code/review-doc/review-skill
leave it open and assigned on a FAIL), which would make it unpickable by the rule above — but
that arc is **yours to drive forward, not skip**. So **before** picking new `status:triaged`
work, scan your own open PRs for one whose **latest** gate verdict (in *any* of the three
namespaces) is an unaddressed FAIL:

```bash
ME=$(gh api user --jq '.login')
# open PRs you authored; print each one whose latest verdict in EITHER namespace is FAIL,
# UNLESS it has already hit the N=3 repair cap (then it's a human's, not yours to re-pick)
gh api "repos/$REPO/pulls?state=open&per_page=100" \
  --jq ".[] | select(.user.login==\"$ME\") | .number" | while read PR; do
  # whose markers count as a verdict — GitHub's repo ACL, the same trust root ship-it Step 2
  # uses (ADR 0055, supersedes 0051): build THIS PR's authorized set from its marker authors
  # holding write+ on the repo, so a forged review-(code|doc|skill): FAIL from a non-reviewer can't
  # trigger spurious repair. Empty set ⇒ IN($authorized[]) matches nothing ⇒ no verdict
  # resolves ⇒ the scan safely finds nothing — fail-closed.
  comments_file=$(mktemp)
  gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file"
  # every marker test below is emphasis-tolerant (leading \** absorbs review-code's bolding)
  # per gh-issue-intake-formats.md §5 — the canonical matcher contract
  markerAuthors=$(jq -r '[.[]
      | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*(PASS|FAIL)"; "i"))
      | .user.login] | unique | .[]' "$comments_file")
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
          | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*FAIL"; "i"))
          | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
     | sort
     | reduce .[] as $t ({n:0, prev:null};
         if (.prev == null) or ($t - .prev) > 120
         then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
     | .n' "$comments_file")
  [ "$ROUNDS" -ge 3 ] && continue   # at the cap → already escalated to a human, excluded from the scan
  CODE=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)"; "i"))]
     | sort_by(.created_at) | last | .body // ""' "$comments_file")
  DOC=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
     | sort_by(.created_at) | last | .body // ""' "$comments_file")
  SKILL=$(jq --argjson authorized "$authorized" \
    '[.[] | select(.user.login | IN($authorized[]))
          | select(.body | test("^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)"; "i"))]
     | sort_by(.created_at) | last | .body // ""' "$comments_file")
  echo "$CODE"  | grep -qiE '^\s*\**\s*review-code:\s*FAIL'  && echo "#$PR review-code FAIL"
  echo "$DOC"   | grep -qiE '^\s*\**\s*review-doc:\s*FAIL'   && echo "#$PR review-doc FAIL"
  echo "$SKILL" | grep -qiE '^\s*\**\s*review-skill:\s*FAIL' && echo "#$PR review-skill FAIL"
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

- **Author-gated verdicts (ADR [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)).**
  Markers count as a verdict **only from a `write+` repo collaborator** — the same GitHub-ACL
  gate `ship-it` Step 2 applies *before* the marker regex. A self-authored or
  forged `review-(code|doc|skill): FAIL` is invisible here, so write-code can't pull *itself* into
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
**first** unassigned issue in the **highest non-empty** bucket — applying the
[milestone tiebreaker](#milestone-aware-ordering) below when several issues share that
bucket. That's your pick — unless it's a sub-issue, in which case run the eligibility
check in Step 2 first.

### Milestone-aware ordering

Milestone is the **optional fourth intake dimension** — strategic sequencing / campaign
grouping, *not* feature breakdown — defined once in the formats contract's
[`## Milestone`](../gh-issue-intake-formats.md) section (the single source of truth;
read it for what a milestone *is* and its REST surface — ADR
[0072](https://github.com/kamp-us/phoenix/blob/main/.decisions/0072-milestones-encode-strategic-sequencing.md)).
write-code is the **consumer** named there: milestone influences **pick-order only**, and
**only as a tiebreaker that respects the priority spine** — it never gates, never blocks a
merge, and never changes *which* issues are pickable.

**The precedence rule (p0 stays sovereign — state this, never weaken it).** A milestone
preference orders candidates **strictly within a single priority bucket** and **never
across buckets**. The priority spine — all p0 before any p1, all p1 before any p2 — is the
top-level sort and is never overridden by a campaign lean. Concretely: **a p0 outside the
active milestone is always picked before any lower-priority issue inside it.** A milestone
bias that could starve an out-of-milestone p0 is a bug, not a feature; the within-bucket
confinement is what makes the campaign lean safe. This precedence holds in **both** modes
below — never reintroduce a milestone-over-priority sort.

Milestone shapes the pick in two modes:

- **Default mode — within-bucket tiebreaker.** With no milestone named, run the normal
  priority-then-age pick, but when a single priority bucket holds several unassigned
  candidates, **break the tie toward the active milestone**: prefer the in-milestone
  candidate over an equal-priority out-of-milestone one; fall back to oldest-first when
  the milestone dimension doesn't separate them (both in, both out, or no active
  milestone). The "active milestone" is the campaign currently being driven — the one the
  operator names, or the obvious single open strategic milestone; if it's ambiguous,
  there is no active milestone and this degrades cleanly to plain oldest-first. Because
  the tiebreaker lives *inside* a bucket, it can only reorder equal-priority issues — it
  can never pull a lower-priority in-milestone issue ahead of a higher-priority one.

- **Explicit `work milestone N` mode — drain that milestone.** When invoked as "work
  milestone N" (or "drain milestone N"), scope the pool to that milestone via the REST
  filter and pick from it by the **same** priority-then-age order:

  ```bash
  # explicit milestone drain: same priority spine, scoped to milestone N (REST, never GraphQL)
  for P in p0 p1 p2; do
    gh api "repos/$REPO/issues?state=open&milestone=$N&labels=status:triaged,$P&sort=created&direction=asc&per_page=100" \
      --jq '.[] | select(.assignee == null and (.pull_request | not)) | "#\(.number)\t\(.created_at)\t\(.title)"'
  done
  ```

  Even here the priority spine wins **inside** the milestone (p0s in the milestone before
  its p1s), and the **explicit scope is the operator's choice** — naming milestone N is a
  deliberate decision to work that campaign, so confining the pool to it is intentional,
  not starvation. If you must guarantee no global p0 is left behind while draining a
  campaign, run the default unscoped pick first; the explicit mode is for when the
  operator has chosen to focus N.

In both modes the pickability predicate is **unchanged** — milestone only *orders* among
issues that are already pickable (`status:triaged` + unassigned, sub-issue eligibility per
Step 2). Read an issue's milestone with
`gh api repos/$REPO/issues/<N> --jq '.milestone.number // "none"'` (none ⇒ the well-formed
default — most issues carry no milestone) per the contract's REST surface.

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

<a id="mis-attribution-guard"></a>
## Step 3.5 — The mis-attribution guard (verify the target is mine before mutating it)

The claim (Step 3) guarantees you *won* a unit of work; this guard guarantees you only ever
*operate on* a number you won. They are complements: without it, a mis-attributed issue/PR
number — a wrong `<N>` substituted into a `gh api … /comments`, a `git push` to the wrong
branch, a close on the wrong issue — silently mutates **another agent's live work**. That is
the #1404 near-miss this step closes (a coder nearly killed another agent's live PR via a
mis-attributed number); it is the `write-code` adoption of ADR
[0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md)
§4 (surface #1456).

**Before any mutating action that targets an issue/PR number** — open a PR against it (Step 5),
comment on it (Step 6 progress, Step 7 handoff), `git switch`/`git push` its branch (repair
R2/R3), or close it (type routing) — verify the target carries **your own** session-stamped
claim, and **refuse — loudly, fail-closed — if that claim is absent or another agent's**. The
guard **reuses the §1 claim-marker read** (ADR 0115 §1/§2); it introduces **no second claim
mechanism**.

### Your claim token — `MY_CLAIM` (own session id, or the orchestrator's delegated token)

The token this run owns its work *under* is `MY_CLAIM`, resolved once at the top of the run:

- **Direct path** — `write-code` invoked directly: `MY_CLAIM` is the coder's own
  `CLAUDE_CODE_SESSION_ID` (the same token the Step-3 claim writes — ADR 0115 §3 direct path).
- **Orchestrated path** — dispatched by the orchestrator, which **pre-claims before spawn**
  (`.claude/workflows/drive-issue.js`, ADR 0115 §3) and **threads its winning claim token into
  the spawn prompt**: `MY_CLAIM` is that **threaded delegated token**. `write-code` **recognizes
  the threaded claim as its delegated own and does not re-race** (it posts no second claim) — the
  guard treats a target whose earliest authorized claim equals the threaded token as *mine*.

```bash
# the claim token this run owns work under: the orchestrator's threaded delegated token if it
# pre-claimed, else my own session id (the direct-path Step-3 self-claim). Fail-closed: with
# NEITHER set there is no agent-distinguishable identity to verify ownership under — abort, never
# fall back to the bare assignee login (that login degeneracy is the exact defect ADR 0115 removes).
MY_CLAIM="${THREADED_CLAIM_TOKEN:-$CLAUDE_CODE_SESSION_ID}"
: "${MY_CLAIM:?mis-attribution guard: no claim token — CLAUDE_CODE_SESSION_ID absent and none threaded; refusing to claim or mutate (ADR 0115 Consequences — never a login fallback)}"
```

### `claim_is_mine <N>` — MANDATED before every issue/PR-number mutation

Define the guard once and gate **every** number-targeting mutation on it, exactly as
[`wt_preflight`](#per-mutation-preflight) gates every git mutation — a green `claim_is_mine`
is the **only** sanctioned path to a mutation that names `<N>`, no bypass:

```bash
# claim_is_mine <N>: resolve the EARLIEST AUTHORIZED claim marker on #N (issue or PR) and assert
# its embedded session id == MY_CLAIM. Returns 0 only on a proven-own claim; non-zero (REFUSE) on
# an absent OR a foreign claim. Reuses the ADR 0115 §1/§2 marker read — no second claim mechanism.
claim_is_mine() {
  local N="$1" cf am authorized winner perm a
  cf=$(mktemp)
  gh api "repos/$REPO/issues/$N/comments?per_page=100" > "$cf"   # PR comments share the issues endpoint
  # claim grammar (ADR 0115 §1):  claim: <CLAUDE_CODE_SESSION_ID> · <ISO-8601-UTC>
  # matched emphasis-tolerant exactly like the review-* markers (leading \** absorbs bolding, §5).
  # SINGLE backslashes: this regex is passed by jq --arg (a raw value), not a jq string literal —
  # so \s/\** reach oniguruma directly (a jq-literal would need \\s; the --arg path must not).
  CLAIM_RE='^\s*\**\s*claim:\s*\**\s*(?<sid>[0-9A-Za-z-]{8,})'
  # AUTHORIZED authors only — write+ collaborators (ADR 0055 trust root, same set ship-it Step 2 /
  # the repair scan build). A forged claim from a non-collaborator is ignored; an EMPTY authorized
  # set resolves NO claim ⇒ the guard refuses — fail-closed, never a false win.
  am=$(jq -r --arg re "$CLAIM_RE" '[.[] | select(.body | test($re;"i")) | .user.login] | unique | .[]' "$cf")
  authorized='[]'
  while IFS= read -r a; do
    [ -z "$a" ] && continue
    perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
    case "$perm" in admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;; esac
  done <<<"$am"
  # WINNER = the EARLIEST authorized claim — min (created_at, comment id), the server-assigned
  # ordering (ADR 0115 §2), NOT lexicographic-min(session). Extract its embedded session id.
  winner=$(jq -r --argjson authorized "$authorized" --arg re "$CLAIM_RE" \
    '[.[] | select(.user.login | IN($authorized[])) | select(.body | test($re;"i"))]
     | sort_by([.created_at, .id]) | first
     | (.body // "" | (capture($re;"i") // {sid:null}).sid) // ""' "$cf")
  if [ -z "$winner" ]; then
    echo "mis-attribution guard FAILED (fail-closed): #$N carries no authorized claim marker — refusing to mutate (ADR 0115 §1/§2: absent ⇒ no owner, never a false win)." >&2
    return 1
  fi
  if [ "$winner" != "$MY_CLAIM" ]; then
    echo "mis-attribution guard FAILED (fail-closed): #$N is claimed by ANOTHER agent (earliest authorized claim session=$winner ≠ mine=$MY_CLAIM) — refusing to push/comment/close work I did not claim (ADR 0115 §4 / #1456; the #1404 near-miss)." >&2
    return 1
  fi
  echo "mis-attribution guard: #$N earliest authorized claim == mine ($MY_CLAIM) — proceeding."
}

claim_is_mine "<N>" && gh api repos/$REPO/issues/<N>/comments -f body="…"   # the guard gates the mutation; never run it ungated
```

The guard is **fail-closed by construction** — it proceeds **only** on positive evidence of an
authorized claim whose session is `MY_CLAIM`; an absent claim, an unauthorized-only claim, and a
foreign claim all **refuse**. It is **observable** (it prints the resolved owner vs `MY_CLAIM`) and
**idempotent** (a read-only GET). **Never** route around it by widening the comparison or treating
the bare assignee as the owner — the assignee is a coarse availability gate only (ADR 0115 §1), and
a login-keyed ownership check is the degeneracy this guard exists to remove.

> **Which `<N>` to guard at each site.** The guarded number is the **work-target whose mutation
> could clobber another agent**: Step 5 guards the **issue** you open the PR against; Step 6 the
> **issue** you comment on; **Step 7 guards the child you own** (the handoff to the parent epic is
> predicated on owning the child — gate on `claim_is_mine <child>`, not the epic, which you never
> claim); repair R2/R3 guard the **PR's linked issue `#N`** (the claim lives on the issue, so
> resolving `Fixes #N` and confirming its claim is `MY_CLAIM` is what proves the PR is yours to
> push); the **repair escalation** sites — both the N=3 cap block and the freeze-after-round-K
> block — guard the **PR's linked issue `#N`** too (the escalation comment + `status:needs-triage`
> relabel are number-targeting mutations reachable as a fresh stateless repair's *first* mutation,
> escalating instead of running R2/R3, so the R2/R3 guards never fire — gate the escalation itself);
> type-routing closes guard the **issue** you close.

> **Composition + ship-ordering (the one honest caveat).** This guard is the **read-side
> complement** of the claim *write*: it verifies the marker that the claim surface posts — the
> Step-3 issue self-claim and the §7 contract (surface #1453), or the orchestrator's pre-spawn
> claim threaded as `MY_CLAIM` (surface #1454). It is **live-correct only once a claim marker is
> posted ahead of the mutation** — which the integrated pipeline always does (orchestrator
> pre-claims, or `write-code` self-claims at its claim step). Landing this guard **ahead of** a
> claim-marker-posting surface would, by its own fail-closed contract, refuse `write-code`'s own
> mutations (no marker yet to verify) — so its ship is sequenced **with or after** #1453/#1454, a
> control-plane ship decision, not a fail-open hedge to weaken here.

### Rehearsal — a mis-attributed number is refused (the #1404 reproduction)

The guard handed a number it did **not** claim refuses to mutate it. Walk the three resolutions:

1. **Foreign claim — REFUSE.** Agent B (its own session `B-sid`) holds the earliest authorized
   claim on issue `#900`. Agent A (`MY_CLAIM = A-sid`) is handed `#900` by a mis-attributed number
   and reaches a mutation. `claim_is_mine 900` resolves `winner = B-sid`; `B-sid != A-sid` ⇒
   **FAILED (fail-closed): #900 is claimed by ANOTHER agent** — A pushes/closes nothing. This is
   the #1404 near-miss, now structurally unreachable.
2. **Absent claim — REFUSE.** The number names an issue with **no** authorized claim marker (or
   only a forged claim from a non-collaborator, which the ADR 0055 author-gate drops). `winner` is
   empty ⇒ **FAILED (fail-closed): no authorized claim marker** — A cannot prove ownership, so it
   refuses rather than mutate an unclaimed number.
3. **My own claim — PROCEED.** The earliest authorized claim on `#N` carries `A-sid` (A's own
   Step-3 self-claim) **or** the token threaded to A by the orchestrator (delegated own). `winner
   == MY_CLAIM` ⇒ the guard prints `earliest authorized claim == mine` and the single guarded
   mutation runs.

Exactly one of three outcomes, decided by a re-read of canonical issue state against `MY_CLAIM` —
the same detect-and-tiebreak shape (ADR 0115 §2), here read-only and on the *acting* side.

---

## Step 4 — Implement on a branch

write-code **MUST run in an isolated git worktree** — when spawned as a subagent, via
the Agent tool's `isolation: worktree`. The operator loop requires it so concurrent
runs can't race or dirty the primary checkout.

### Step 4 preflight — assert you're in a worktree, fail closed if not (ADR 0092)

**Run this before you branch or touch a single file.** "write-code runs in a worktree"
was a *documented* invariant nobody *asserted* — so a misconfigured spawn (no
`isolation: worktree`, or a harness cwd-reset that drops you back in the primary checkout
between calls) would sail past it and branch the **owner's primary checkout**, the exact
mis-branch the MEMORY notes burn on. This is the silent-no-op failure mode at the agent
layer, so it gets the same fix the gates get: **emit what you scanned, then FAIL CLOSED on
the unsafe state** (ADR
[0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md)).

The check is a one-liner of plumbing, portable across git ≥ 2.5: a **linked worktree**'s
per-tree git dir (`.git/worktrees/<id>`) is **not** the shared **common** dir (`<primary>/.git`),
whereas in the **primary checkout they are the same path**. Equal ⇒ you're in the primary
checkout (or a bare/no-repo edge) ⇒ **stop**; differ ⇒ you're in a linked worktree ⇒ proceed.

```bash
# fail closed unless we're in a LINKED git worktree (not the primary checkout)
GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
  echo "write-code preflight FAILED: not inside a git repository — refusing to mutate." >&2; exit 1; }
COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
case "$COMMON" in /*) ;; *) COMMON="$(pwd)/$COMMON" ;; esac   # normalize relative `.git` (older git)
COMMON="$(cd "$COMMON" && pwd)"
echo "write-code preflight: git-dir=$GITDIR common-dir=$COMMON cwd=$(pwd)"   # emit scanned scope (ADR 0092 §1)
if [ "$GITDIR" = "$COMMON" ]; then
  echo "write-code preflight FAILED (fail-closed): git-dir == common-dir ⇒ this is the PRIMARY checkout, not an isolated worktree." >&2
  echo "  Refusing to branch/commit here — a spawn without isolation:worktree (or a cwd reset to the primary tree) would mis-branch the owner's checkout." >&2
  echo "  Fix: re-spawn write-code with isolation:worktree, or take the Non-isolated fallback below to create a worktree before mutating." >&2
  exit 1
fi
```

The preflight is **fail-closed by construction**: it refuses on the primary checkout, on a
not-a-repo cwd, *and* on the ambiguous default — only positive evidence of a linked worktree
(git-dir ≠ common-dir) lets it through. It is **observable** (it prints the two dirs + cwd it
compared, so "what did the preflight look at" is answerable from the run log) and **idempotent**
(read-only `git rev-parse`, safe to re-run). The **one** sanctioned way to satisfy it from a
non-worktree start is the [Non-isolated fallback](#non-isolated-fallback) below — which creates
a real linked worktree and `cd`s into it, after which this same check passes. **Never** route
around the preflight by deleting it or relaxing the comparison; a green preflight is the
precondition every mutation in Steps 4–7 relies on.

<a id="per-mutation-preflight"></a>
> **The preflight runs once at Step-4 start AND re-asserts before EVERY git-mutating op.**
> The harness resets an isolated subagent's shell cwd back to the **primary** checkout
> *between* Bash calls (edits still land in the worktree, but a fresh `git` invocation runs
> where the cwd points). A `git commit`/`git push`/branch op issued *after* such a reset runs
> against the **shared primary tree** even though the opening preflight was green — so two
> parallel runs serialize their commits onto whatever branch the primary tree is on,
> cross-contaminating each other's PRs (#832). One pass at Step-4 start does **not** hold for
> the whole run.
>
> Capture your worktree root once, then run this **mandatory per-mutation preflight** —
> `wt_preflight` — *immediately before* every `git commit`, `git push`, and branch
> create/switch (Steps 4, 5, R2, R3). It re-`cd`s to your own worktree root first (correcting
> a between-calls reset), then re-runs the same fail-closed check **and** asserts the toplevel
> is your worktree. A green `wt_preflight` is the **only** sanctioned path to a mutation — no
> bypass, same construction as the opening preflight:
>
> ```bash
> WT="$(git rev-parse --show-toplevel)"   # capture ONCE, right after the opening preflight passes
> wt_preflight() {   # MANDATED before every git commit/push/branch op — fail-closed, re-correcting cwd
>   cd "$WT" || { echo "wt_preflight FAILED: cannot cd to worktree root $WT" >&2; return 1; }
>   GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
>     echo "wt_preflight FAILED: not in a git repo at $WT" >&2; return 1; }
>   COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
>   case "$COMMON" in /*) ;; *) COMMON="$(pwd)/$COMMON" ;; esac
>   COMMON="$(cd "$COMMON" && pwd)"
>   TOP="$(git rev-parse --show-toplevel)"
>   echo "wt_preflight: git-dir=$GITDIR common-dir=$COMMON toplevel=$TOP wt=$WT"
>   [ "$GITDIR" != "$COMMON" ] || { echo "wt_preflight FAILED (fail-closed): on the PRIMARY checkout, not the worktree — refusing to mutate." >&2; return 1; }
>   [ "$TOP" = "$WT" ]        || { echo "wt_preflight FAILED (fail-closed): toplevel ($TOP) != my worktree ($WT) — cwd reset landed me in a sibling/primary tree." >&2; return 1; }
> }
> wt_preflight && git <commit|push|switch …>   # the guard gates the mutation; never run the mutation without it
> ```

This constrains how you branch: `main`
is already checked out in the primary tree, so `git checkout main` **fails** inside an
isolated worktree (`fatal: 'main' is already checked out at <primary>`). Branch from
latest origin `main` **without checking it out**:

```bash
git fetch origin main
# Derive the prefix from THIS checkout's git identity — never a hardcoded literal. A copied
# literal namespaces every agent's branch under one person's handle regardless of who runs.
PREFIX="$(git config user.name | tr '[:upper:] ' '[:lower:]-')"   # e.g. "Umut Sirin" → "umut-sirin"
: "${PREFIX:?set git user.name to derive a branch prefix}"        # empty identity ⇒ "/slug…" (leading slash) git rejects with an opaque error; fail here with a fixable one
# Per-run suffix: the deterministic $PREFIX/<slug-for-issue-N> is the SAME ref for every
# run on this issue, so two concurrent runs would both push origin/<that branch> and the
# second push would clobber the first's commits. A per-invocation nonce keeps them distinct.
BRANCH="$PREFIX/<slug-for-issue-N>-$(uuidgen | head -c 8)"
wt_preflight && git switch -c "$BRANCH" FETCH_HEAD   # branch create is a git mutation → gate it (per-mutation preflight above)
```

It's `git switch -c "$BRANCH" FETCH_HEAD` (not `git checkout main`) on purpose: in an
isolated worktree `main` is checked out elsewhere, so branching directly off the
freshly-fetched `FETCH_HEAD` is the only flow that works — don't "fix" it back to a
`main` checkout.

The prefix is **derived** from this checkout's `git config user.name`, not a copied literal —
so the branch lands under *your* handle (`<your-handle>/…`), whoever runs the skill, instead
of inheriting someone else's namespace. Append a short kebab-case slug naming the work and the
per-run nonce so two concurrent runs on the same issue never push the same `origin/` ref. Read the issue's `### What to build` for scope
and honor the `**TDD:**` flag — `yes` means write the failing test first, then make it
pass; `no` means config/docs/scaffolding where test-first doesn't apply.

<a id="non-isolated-fallback"></a>
> **Non-isolated fallback.** For the rare invocation that isn't already in a worktree,
> spin one up rather than checking out `main`. Carry the same per-run `$BRANCH` (nonce and
> all) and a per-run worktree path so two concurrent fallback runs collide on neither the
> branch nor the dir: `WT="../wt-issue-<N>-$(uuidgen | head -c 8)"; git worktree add -b
> "$BRANCH" "$WT" origin/main`, then `cd "$WT"`. When you're done, remove it with
> `git worktree remove "$WT"`. After the `cd "$WT"`, **re-run the Step 4 preflight** — the
> fresh worktree's git-dir now differs from the common dir, so the check passes and you may
> mutate. This is the *only* sanctioned route from a primary-checkout start; the preflight
> stays fail-closed until a real worktree exists.

Ground the implementation in the codebase the way the repo expects: the ADRs in
`.decisions/` are the *why* and the binding decisions, the patterns in `.patterns/`
are *how the current code is shaped* — read the relevant ones before writing, and
follow them over intuition (per `CLAUDE.md`). Implement the issue's acceptance
criteria; they are the literal checklist `review-code` will verify, so build to make
every box checkable from the outside. Run `pnpm typecheck` and the test suite as the
repo conventions require before you open the PR.

For **lint**, run **`pnpm lint:worktree`**, not `pnpm lint`. Bare `pnpm lint`
(`biome check .`) self-no-ops from inside the worktree: `.` resolves to the
worktree's own CWD, which physically sits under `.claude/worktrees/<id>` and so
matches the retained `!**/.claude/worktrees` exclusion — biome reports "0 files /
paths ignored" without linting anything (a false-clean that sailed past local checks
and only failed in CI; #236, #553,
[ADR 0060](https://github.com/kamp-us/phoenix/blob/main/.decisions/0060-worktree-lint-changed-paths.md)).
`pnpm lint:worktree` lints the **explicit changed files** instead (committed *and*
working-tree, vs `origin/main`), filtered to biome-handled extensions so a
docs/markdown-only diff is a **clean skip (exit 0)**, never bare `.`. It catches the
same violations CI's `lint / format / typecheck` job would — including in root and
`.claude/**` files, which a bare `biome check apps packages` would miss — so a clean
`pnpm lint:worktree` reliably predicts a green CI lint.

```bash
pnpm lint:worktree
```

### Editing a skill — use the real `skills/**` path, never the `.claude/skills/**` symlink

When the issue has you **editing a skill** (a `SKILL.md` or its supporting files), edit the
**real** path under `claude-plugins/<plugin>/skills/<name>/…` (e.g.
`claude-plugins/kampus-pipeline/skills/write-code/SKILL.md`), **never** the `.claude/skills/<name>/…`
path. `.claude/skills` is a **symlink to the real plugin skills dir** — both resolve to the same
file on disk — but the harness's auto-mode **self-modification classifier keys on the path
*string***: any `Edit`/`Write` whose target contains `.claude/` is flagged "Self-Modification
(config file controlling agent behavior)" and **hard-blocked** when the authorization comes from an
issue/tool rather than the user's own message. The identical file edited via the real
`claude-plugins/**/skills/**` path is not flagged. So the `.claude/` path is a coin-flip into an
**opaque** failure (it surfaces as a generic `build-failed` with no PR, not "blocked by the self-mod
guard"), costing a wasted retry + manual diagnosis (#599, #637). Always resolve the real path first.
PR bodies and progress comments must describe the changed path as the real `claude-plugins/**/skills/**`
path too, so the diff a reviewer reads matches what you wrote.

> **Editing `.claude/` *content* (not a symlinked skill) needs a Bash scripted-replace.** The same
> guard blocks the `Edit`/`Write` *tools* on any genuine `.claude/` path that has no real-path alias —
> e.g. `.claude/settings.json`. There's no symlink to route around for those, so apply the change with a
> Bash-scripted in-place replace (a `node`/`sed` splice) rather than the Edit tool. (Most write-code
> tasks don't touch `.claude/` content at all — this is the escape hatch for the ones that must.)

Commit per repo conventions, gating each `git commit` on `wt_preflight` (the
[per-mutation preflight](#per-mutation-preflight) above) so a between-calls cwd reset can't
land the commit on the primary tree. Don't push to or PR from `main`.

---

## Step 4b — Ship dark behind a default-off flag on a containment-marked child

When the child you picked carries **`**Containment:** flag (default-off)`**, the implementation
above isn't done until the new user-facing path **ships dark**: behind a boolean flag that is
**off by default**, so the feature reaches `main` and production deployed-but-not-live until a
human deliberately flips it. This is the product-development cycle's **agents-deploy / humans-release**
contract (ADR
[0083](https://github.com/kamp-us/phoenix/blob/main/.decisions/0083-agents-deploy-humans-release.md)):
your autonomous merge is the *deploy*, the flip is the human *release*, and a default-off flag is
what makes the no-eyeball auto-ship safe — a bad merge sits dark, contained, never seen by a user.
`plan-epic` stamps the marker, you ship dark on it, and `review-code` Step 3b verifies the gating.

The marker contract — its values, its tolerant-read rule, who writes vs reads it — is defined once
in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md#the-product-development-cycle-hook)
(§The product-development cycle hook); read it there, this step is the *reader's behavior* on the
ship side.

**Read the marker off the child you're implementing**, tolerantly per the formats §Reading stance —
a `**Containment:**` line, with a leading bold-marker, anywhere in the body; a **missing line reads
as `none`**:

```bash
# the child's containment marker; a missing line reads as `none` (formats §2 tolerant-read rule)
CONTAINMENT=$(gh api repos/$REPO/issues/<N> --jq '.body' \
  | grep -ioE '\**\s*Containment:\**\s*(flag|exempt|none)' | head -n1 \
  | grep -ioE '(flag|exempt|none)' || echo none)
```

**Graceful absence — the dark-ship behavior applies only when there's a cycle.** It fires **only**
when the marker resolves to `flag` *and* the repo has a `product-development-cycle.md` (the one
canonical probe, formats §1). On `exempt`, `none`, a missing line, or an **absent** cycle doc (a
foreign install with no cycle and no flag substrate — ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)), this
step is a **no-op**: you implement and ship the change exactly as Steps 4/5 already describe, with
**no flag introduced**. Absence is a first-class, correct state, not a defect — the same
graceful-absence contract `plan-epic` (stamp) and `review-code` (verify) honor:

```bash
# the canonical cycle-doc probe (formats §1); absent ⇒ no cycle ⇒ ship normally, no flag
gh api "repos/$REPO/contents/product-development-cycle.md" --jq '.path' >/dev/null 2>&1 \
  && CYCLE_DOC=present || CYCLE_DOC=absent
# ship dark ONLY when:  [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]
```

When it **does** fire, ship dark per the dark-ship procedure — **don't re-derive the mechanics**.
The change gates behind a default-off flag, which is **one of two shapes** that this step treats
**identically** from here on:

- **Newly-declared in this diff** — no suitable flag exists yet, so you mint one: declare a
  default-off flag and gate the new path following
  [`.patterns/feature-flags-agent-workflow.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/feature-flags-agent-workflow.md)
  (the ship-behind-flag workflow, #514), naming the flag by the grammar in
  [`.patterns/feature-flags-schema-lifecycle.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/feature-flags-schema-lifecycle.md)
  (`<product>-<feature>-<purpose>`, kebab-case, #513).
- **Gated behind a flag a PRIOR PR already declared** — the flag resource is **not in this diff**
  (an earlier PR minted it; you only add the gated path under the existing key). The #1277/#1205
  shape: a feature gated behind the prior-PR #1204 authorship flag.

Whichever shape applies, **capture the exact kebab-case flag key as `FLAG_KEY`** — it is the single
fact that flows out of this step. The load-bearing invariant the patterns own is **default =
safe-state**, the three facets `review-code` Step 3b will verify, so build to make each checkable
from the outside:

- **Declare it default-off** (newly-declared shape only) — a
  `FlagshipFlag(..., { defaultVariation: "off", … })` in
  `apps/web/worker/db/resources.ts` (workflow Step 1), with the per-flag metadata (owner,
  originating issue, removal trigger) that lets it be retired later. In the prior-PR shape the
  declaration already exists upstream — don't re-declare it; just reference its key.
- **Gate the new path with the safe read default** — server `flags.get*(key, false)` and client
  `useFlag(key, false)` / `<FlagGate fallback={…}>`, so the new path is unreachable until the flip
  and any Flagship outage degrades to the **old** path (workflow Step 2).
- **No leak** — every entry into the new behavior sits behind the gate: no default-on, no inverted
  gate, no ungated client path.

**Emit `FLAG_KEY` into the PR body — the producer half of ship-it's release-queue detector.**
ship-it Step 5b queues `status:awaiting-release` on the merged PR iff one of two PR-ground-truth
signals fires: (a) the diff *adds* a flag declaration, or (b) the PR body carries a plain
`Flag: <key>` line. Signal (a) is **absent by construction in the prior-PR shape** (the flag
declaration lives in an earlier diff), so signal (b) is the **only** signal that survives across
PRs — and it survives only if write-code *writes* it. So whenever this step fires — **either
shape, one consistent producer rule, never two** — **carry `FLAG_KEY` into Step 5's PR-body
construction as a plain `Flag: <FLAG_KEY>` line** (see Step 5). Without it, a prior-PR dark ship is
structurally invisible to Step 5b and silently skips the agents-deploy / humans-release flag-flip
gate ADR 0083 exists to enforce (#1282).

The PR then ships dark the normal way (Step 5): the diff is `apps/web/**`, **not** control-plane, so
`review-code`'s PASS auto-ships it on green CI — and it reaches production **off** because both the
declared default and the read default are off. Note this in your Step 6 progress comment (the flag
key + that it ships dark) so `review-code` and a later releaser can find it. **Out of scope here:**
validating, flipping, or retiring the flag — those are the human release act and the retirement
chore (workflow Steps 4–7), never a `write-code` step.

---

## Step 4c — Self-deslop your own freshly-generated diff (a pre-push self-check, never a gate)

Before you push (Step 5), run the **`deslop-comments` discipline over the lines this diff
changed** — and only those lines. AI-generated code reliably over-comments: narration of
obvious control flow, comments that restate the symbol they sit on, separator/banner
comments, and docblocks that re-derive a *why* an ADR already owns. CLAUDE.md's "Comments
earn their place or die" is the standing rule, but nothing in the autonomous loop enforced
it on fresh churn — so the wall landed in merged PRs (#1242). This step is that
enforcement, run by the author on its own output at the cheapest point.

**Apply the existing skill — don't re-derive its rubric.** The category rules (CUT /
COLLAPSE / MIGRATE / KEEP), the one test ("would the next agent be wrong, slower, or
surprised without this comment, in a way the code itself doesn't already tell them?"), and
the hard nevers (never touch code, never strip a `TODO`/pragma/license header, never invent
an ADR number) live in
[`../deslop-comments/SKILL.md`](../deslop-comments/SKILL.md) — read it and follow it
verbatim. Two scope narrowings apply here because this is an in-flight build, not a
whole-codebase pass:

- **Changed lines only.** Deslop the comments *your diff added or touched*
  (`git diff origin/main...HEAD` for the committed range, plus any working-tree changes) —
  not pre-existing comments elsewhere in the files you edited. A drive-by deslop of
  untouched code widens the diff `review-code` must verify and isn't the issue's scope.
- **Preserve load-bearing notes.** The carve-out is the point: a local invariant at its
  enforcement site, a workaround + its forcing constraint, a deliberate-looking-wrong guard,
  a pragma rationale, an ADR pointer — these stay. Cut slop, keep the note that tells the
  next agent something the code can't. If a docblock carries real unhomed *why*, collapse it
  to a pointer or migrate it per the skill's MIGRATE fork — never silently delete it.

After deslopping, commit the comment-only change (gate it on `wt_preflight` like every other
commit) so the pushed head carries the cleaned diff.

> **This is a self-check, not the gate — the split-role firewall holds.** Deslopping your
> *own* diff before push is exactly the "re-reading your own diff to self-check before you
> push is fine" carve-out from the intro. It is a self-edit, not a review: you do **not**
> run `review-code`/`review-doc`/`review-skill` on your PR, and you do **not** emit a
> `review-*` verdict marker. The independent gate still judges the result with fresh eyes —
> this step only keeps the wall out of what it judges.

> **Placement rationale (why self-deslop here, not in the review gate).** The deslop
> discipline is wired into write-code as a pre-push self-check — placement (a) — rather than
> as a `review-code` comment-density finding (b) or both (c). Reason: it is the lightest fit
> that closes #1242's invocation gap. write-code already sanctions self-checking the diff
> before push, so a deslop pass adds **no new gate round-trip** and **no new firewall
> surface**; routing it through `review-code` instead would promote a *style* convention into
> a fail→repair gating loop and pull a non-gate-critical concern into the §CP-classified
> review skill. Comment density is a self-correctable authoring concern, not a correctness
> contract the independent gate must adjudicate — so it belongs at the author's seat. A full
> ADR isn't warranted for a within-skill placement call; this note is the record.

---

## Step 5 — Open a PR that closes the issue

Open the PR with **`Fixes #N` in the body** so merging auto-closes the issue (this is
the seam `review-code` relies on: pass → merge → `Fixes #N` closes it). Use the issue
number you're implementing.

**Always emit a real GitHub *closing keyword* — `Fixes #N` (or `Closes #N`/`Resolves #N`) —
never `Refs #N`, `Re: #N`, `See #N`, or a bare `#N`.** This is a load-bearing invariant, not
a phrasing preference: GitHub only auto-closes the linked issue when the body carries one of
its recognized **closing** keywords, and only a closing keyword populates
`closingIssuesReferences`. A non-closing mention (`Refs`/`Re:`/bare `#N`) renders a
cross-reference that *looks* linked in the timeline but **closes nothing** — so the issue
never auto-closes on merge, and `ship-it` Step 1 (which resolves the linked issue from
`Fixes|Closes #N`) sees a code-class PR with **no auto-close seam** and **refuses to merge**
it: a verified, merge-ready PR stalls in the autonomous lane on one wrong token, with the
linked issue left dangling even if force-merged (#647; PR #573 shipped `Refs #569` and
jammed). The whole downstream merge stage depends on this exact token, so spell out `Fixes #N`
verbatim and never substitute a near-synonym that GitHub doesn't treat as closing.

**The inverse half — a closing keyword is a *targeted* directive, never sprinkled.** Emit a
closing keyword for the **single** issue this PR closes and **nothing else**: *every other*
issue you name in the body — a sibling, a related issue, a "see also", a parent-epic mention
in prose — takes a **non-closing** form (`addresses #M`, `relates to #M`, `see #M`, or a bare
`#M` with no preceding closing verb). GitHub parses a closing keyword + `#M` **anywhere** in
the body as a close directive with no "first ref" or "same line" exception, so a sibling-ref
`fixes #M` buried in prose silently auto-closes an issue the PR never touched (#1259). The
canonical statement of this rule — both halves (arm the seam for the target / never arm it for
any other ref) and the full case-insensitive landmine keyword set — lives in the contract's
[§9 The PR-body closing-keyword seam](../gh-issue-intake-formats.md); read it there and don't
re-derive it. Operationally: one closing keyword, on the target, full stop — and the `(c)`
guard below mechanizes "the closing-keyword set is exactly `{N}`" as the pre-push self-check.

**The partial-split case — emit `Part of #N` instead of `Fixes #N` when the issue must stay open.**
The default is a closing `Fixes #N` (full close); the **explicit** exception is an intentional
**partial-split** PR — one that advances an issue while a **sibling lane** finishes the rest, so
the issue must **stay open** after this PR merges. For that PR, emit a plain `Part of #N` line
naming the exact issue number **instead of** a closing keyword — `Part of` is **not** a GitHub
closing keyword, so it links the PR to `#N` (a timeline cross-reference) without populating
`closingIssuesReferences` and without auto-closing `#N` on merge, which is precisely the
partial-split intent. `ship-it` Step 1 recognizes a literal `Part of #N` as a valid
linked-but-non-closing reference and merges the PR without closing `#N` (the #1342 consumer, PR
#1347) — so this is the one producer token that gets a partial-split PR through the gate without a
human hand-editing the body. The marker is defined once in the contract's
[§9 The PR-body closing-keyword seam](../gh-issue-intake-formats.md) (its `Part of #N` subsection);
cite §9, don't re-derive it here. This reconciles with **both** halves of the Step 5 self-check:
with the `(b)` armed-seam check, which treats a `Part of #N` marker as a *correctly-armed*
partial-split seam (not a broken one) so it never drives you to patch in a closing `Fixes #N`;
and with the `(c)` inverse guard, because `Part of` is not a closing keyword, so a `Part of #N`-only
PR has a closing-keyword set of exactly `{}` — `Part of #N` is never a stray close directive —
which is correct, it closes nothing. Use this **only** for a genuine partial-split (sibling lane
left to finish); a PR that fully completes its issue emits the closing `Fixes #N` as always.

**If Step 4b fired, add a plain `Flag: <FLAG_KEY>` line to the body.** This is the producer half
of ship-it's release-queue detector (§Step 4b): whenever the change ships gated behind a flag — the
newly-declared shape **and** the prior-PR shape, one consistent rule — emit a body line naming the
exact kebab-case key you captured as `FLAG_KEY`. Write it as a **plain** line, no markdown header or
list prefix:

```
Flag: <FLAG_KEY>
```

The exact shape matters: it must match ship-it Step 5b's `FLAG_IN_BODY` grep
(`^[[:space:]]*\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*[a-z0-9]+(-[a-z0-9]+)+`),
so the key is lowercase kebab-case and the line starts with a bare `Flag:` (or `Flag key:`) — **not**
`## Flag:`, `- Flag:`, or `**Flag:**` (a `##`/`-` prefix breaks the leading-anchor match). This is
the only signal that survives when the flag was declared in a **prior** PR, so without it that dark
ship is invisible to Step 5b (#1282). **Conversely, an ungated PR — no Step-4b dark feature — emits
NO `Flag:` line**, so Step 5b correctly no-ops and no phantom `status:awaiting-release` is queued (no
regression of #1257/#1271). In the graceful-absence case (no `product-development-cycle.md` / no flag
substrate, ADR 0062) Step 4b never fires, so there is no `FLAG_KEY` and no `Flag:` line — the PR
ships normally.

```bash
wt_preflight && git push -u origin "$BRANCH"   # gate the push ([per-mutation preflight]); same per-run branch from Step 4
# The PR opens AGAINST issue #N (Fixes #N) — gate it on the mis-attribution guard (Step 3.5): open a
# PR closing only an issue whose claim is mine, never one mis-attributed to another agent's #N.
claim_is_mine "<N>" || { echo "refusing to open a PR against #<N> — not my claim (Step 3.5)"; exit 1; }
# The body carries `Fixes #N` always; ADD the `Flag: <FLAG_KEY>` line BELOW it ONLY when Step 4b
# fired (a dark ship behind a flag — newly-declared OR prior-PR). Omit it entirely for an ungated PR.
gh pr create \
  --base main \
  --title "<concise PR title>" \
  --body "$(cat <<'EOF'
<short summary of what changed and why>

Fixes #<N>
Flag: <FLAG_KEY>
EOF
)"
```

> `gh pr edit` is unreliable in this org (Projects-classic). If you must edit a PR
> after creation, patch via REST: `gh api -X PATCH repos/$REPO/pulls/<PR>
> -f body="…"`. Get the PR body right at `create` time and you won't need it.

Confirm two things — that the cross-reference landed, **and** that the body you pushed
actually carries a **closing** keyword (the part a `Refs`/bare-`#N` slip silently fails).
The authoritative `closingIssuesReferences` field is **GraphQL-only**, and this org bans
GraphQL (top-of-skill rule) — and the REST issue timeline renders the same
`cross-referenced` event for a closing *and* a non-closing mention, so neither REST signal
alone proves the seam armed. The REST-checkable proof is therefore the **body keyword
itself**: read the PR body back and assert it matches a recognized closing keyword against
`#N` — that is exactly the token GitHub auto-closes on and that `ship-it` Step 1 resolves:

```bash
# (a) the cross-reference landed (a closing OR non-closing mention both show here — necessary, not sufficient)
gh api repos/$REPO/issues/<N>/timeline \
  --jq '.[] | select(.event == "cross-referenced") | .event'
# (b) the SUFFICIENT check, REST-only: the seam is armed iff the body carries EITHER a real
#     CLOSING keyword for #N (full-close PR — the same set ship-it Step 1 resolves:
#     fix(es|ed)/close[sd]?/resolve[sd]?) OR a `Part of #N` partial-split marker (the §9
#     non-closing link that keeps #N OPEN by design). Only NEITHER is a truly broken seam.
BODY=$(gh api repos/$REPO/pulls/<PR> --jq '.body')
if printf '%s' "$BODY" | grep -qiE '\b(fix(e[sd])?|close[sd]?|resolve[sd]?)\s+#<N>\b'; then
  echo "closing seam armed"
elif printf '%s' "$BODY" | grep -qiE '\bpart of\s+#<N>\b'; then
  echo "partial-split seam armed — Part of #<N>, no closing keyword by design (§9; #<N> stays open)"
else
  echo "BROKEN SEAM — body links #<N> with neither a closing keyword nor a 'Part of #<N>' marker"
fi
# (c) the INVERSE GUARD, REST-only: NO closing keyword targets any issue OTHER than #N.
#     The set {issue numbers preceded by a closing keyword in the body} must be exactly {N};
#     a stray member is a sibling-ref directive that auto-closes an issue this PR never fixed (#1259).
STRAY=$(gh api repos/$REPO/pulls/<PR> --jq '.body' \
  | grep -ioE '\b(fix(e[sd])?|close[sd]?|resolve[sd]?)\s+#[0-9]+' \
  | grep -oE '[0-9]+' | sort -u | grep -vx '<N>')
[ -z "$STRAY" ] \
  && echo "no stray close directives — closing-keyword set is exactly {#<N>}" \
  || echo "STRAY CLOSE DIRECTIVE(S) on $(printf '#%s ' $STRAY)— rewrite these sibling refs to a non-closing form (addresses/relates to/see #M) before opening/patching the PR"
# (d) DARK-SHIP GUARD, REST-only: IF Step 4b fired, the body MUST carry a `Flag:` line that
#     matches ship-it Step 5b's FLAG_IN_BODY grep verbatim — else the prior-PR dark ship is dropped
#     from the release queue (#1282). Run this check ONLY when Step 4b fired (FLAG_KEY is set).
if [ -n "$FLAG_KEY" ]; then
  gh api repos/$REPO/pulls/<PR> --jq '.body' \
    | grep -Eiq '^[[:space:]]*\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*[a-z0-9]+(-[a-z0-9]+)+' \
    && echo "dark-ship Flag: line present and matches ship-it Step 5b — release queue will fire" \
    || echo "MISSING/MALFORMED Flag: line — Step 4b fired but the body has no matching plain 'Flag: <key>' line; patch it in before stopping (#1282)"
fi
```

If (b) reports a broken seam, the body links `#N` with **neither** a closing keyword **nor**
a `Part of #N` marker (a `Refs`/bare-`#N` slip): **fix it before stopping** — re-`create` is
gone, so patch the body via REST (`gh api -X PATCH repos/$REPO/pulls/<PR> -f body="…"`) with a
real `Fixes #N` for a full close, **or** — for an intentional partial-split that must keep `#N`
open — a `Part of #N` marker (§9), then re-check, since shipping the PR with a broken seam is
exactly the #647 stall. **Do not** apply this remediation to a PR whose body already carries
`Part of #N`: `(b)` reports `partial-split seam armed` there, not a broken seam, so it does **not**
need fixing — adding a `Fixes #N` to a `Part of #N`-only partial-split would auto-close on merge
the very issue the split must keep open, re-introducing the premature-auto-close class. If (c) reports a **stray**
close directive, a sibling/related `#M` carries a closing keyword that will wrongly auto-close
`#M` on merge — patch the body the same way to downgrade each stray `#M` to its non-closing
form (`addresses`/`relates to`/`see #M`) and re-run (c), since shipping it is exactly the
#1259 silent-auto-close. If (d) reports a missing/malformed `Flag:` line on a Step-4b dark ship,
patch the body via REST to add the plain `Flag: <FLAG_KEY>` line and re-run (d), since shipping it
without the line silently drops the dark ship from ship-it's release queue (#1282).

---

## Step 6 — Log progress on the issue

Throughout the work, and at minimum when you open the PR, post a **progress comment**
on the issue you're working in the format-3 shape (Completed / Decisions / Gotchas /
Next — see [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §3). This
is the per-issue ledger for the next agent (a successor write-code run, or
`review-code`): what moved, what you decided and why, what bit, what's still open.

```bash
BODY="$(cat /tmp/write-code-progress.md)"   # the four-section comment
# gate the comment on the mis-attribution guard (Step 3.5) — only comment on an issue whose claim is mine
claim_is_mine "<N>" && gh api repos/$REPO/issues/<N>/comments -f body="$BODY"
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

### Cross-issue writes need spawn-time pre-authorization (the clause below)

This handoff is a **cross-issue write**: the spawned write-code agent comments on the
**parent epic**, an issue it did **not** create this session. The auto-mode classifier
**blocks an agent from writing to any issue/PR it didn't open** unless the spawn prompt
**pre-authorizes** it — so a write-code agent that implemented its child perfectly will
**silently fail to land the Step 7 handoff** (and likewise a `Fixes #N` epic-close write, or
a progress comment on a sibling) if the spawner forgot the clause. This is tribal knowledge
that costs a lost handoff every time it's forgotten; the fix is to make the clause
**copy-pasteable and to point spawners at it from inside the skill** rather than re-derive
the classifier constraint each time.

**Whoever spawns a write-code subagent must include this clause in the spawn prompt** (the
in-repo, copy-pasteable form of the out-of-repo orchestrator's authorization — ADR 0046 keeps
the orchestrator's spawn *template* out of this repo, so this skill carries the **clause text**
the template should inline):

> **Cross-issue write pre-authorization.** You are authorized to write to issues/PRs you did
> not create **for these pipeline writes only**: (1) the Step 7 **epic handoff note** on the
> parent epic, (2) a `Fixes #N` / epic-close write on the linked issue or its parent, and
> (3) progress comments on the issue you were dispatched for. Name the parent epic # and the
> linked issue # explicitly here so the classifier scopes the grant. Do **not** read this as
> blanket cross-issue write access — it is exactly these handoff/close writes for **this**
> dispatch, nothing wider.

If you reach Step 7 and find you **cannot** post to the parent epic (the classifier blocks the
write because the clause was omitted), that is **not** a reason to skip the handoff: surface it
in your run ledger as a **missing pre-authorization** (name the epic # you could not write to)
so the spawner re-dispatches with the clause, rather than dropping the cross-task signal
silently. A blocked handoff is a fail-loud condition, never a silent no-op.

```bash
BODY="$(cat /tmp/write-code-handoff.md)"   # ### Handoff: #N — <title> + the three fields
# the handoff to the parent epic is predicated on OWNING THE CHILD — gate on claim_is_mine <child>
# (Step 3.5), not the epic (which you never claim): only hand off about work whose claim is mine.
claim_is_mine "<N>" && gh api repos/$REPO/issues/<EPIC>/comments -f body="$BODY"
```

Distill, don't dump — the fine detail lives in the child's progress comments and PR.
**"Affects siblings" is the load-bearing field:** if finishing this child changed what
a later phase should do (a new module, a changed contract, a decision recorded), say
so — that's the context the `## Dependencies` graph routes along. If the child finished
in pure isolation with zero sibling impact, a one-line "Done" handoff is honest and
complete; don't manufacture cross-task context that isn't there.

A standalone (non-sub-issue) issue has no parent epic — skip this step.

---

## Step 8 — Hard-stop at PR-open: hand the gate to a separate reviewer (never self-review)

This is the **terminus of initial-build mode**, and it is a hard stop. Once the PR is open
(Step 5), progress is logged (Step 6), and any epic handoff is posted (Step 7), **you are
done — full stop.** Do **not** continue into the review gate on the PR you just opened:

- **Never run `review-code`/`review-doc`/`review-skill` on your own PR.** The gate is a
  **separate reviewer's** job by design (the split-role firewall in the intro). Running the
  review skill on your own diff *is* the self-evaluation collapse the pipeline exists to
  prevent — the implementer grading its own work — even though you'd nominally be "just
  checking." The verification you owe is making the AC checkable from the outside (Step 4),
  **not** producing the verdict yourself.
- **Never post a `review-(code|doc|skill): PASS`/`FAIL` marker on your own output**, and never
  open/submit a native PR review (APPROVE/REQUEST_CHANGES) on it. Those are reviewer artifacts;
  emitting one from the implementer seat forges a verdict the gate's ACL author-check (ADR
  [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md))
  is meant to keep honest, and races the dedicated reviewer (the #661 stale-verdict collision).
- **Do not self-assign a reviewer, re-trigger the gate, or merge.** The gate is **stateless and
  pull-driven** — opening the PR (and, in repair, pushing) is the *only* signal it needs; it
  re-runs on its own when a separate reviewer picks the PR up. `ship-it` owns PASS → merge, and
  for a control-plane `.claude`/`.github` PR a **human** does (ADR
  [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)).

The split-role guarantee holds **without per-spawn babysitting**: this hard stop is the skill's
own rule, not a hand-off line a spawner must remember to include (the omitted-clause failure that
let implementers walk into the gate — #664). You re-enter this skill **only** later, in
[Repair mode](#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit), when a *separate*
reviewer has landed a FAIL on your PR — and even then you fix and resubmit, never review (Step R3).
If you were spawned with a wider "review-and-ship this through" instruction, the structural rule
here **wins** over it: open the PR, hand off, and stop — flag in your run ledger that the gate is
left to a separate reviewer.

---

## Repair mode — consume a gate FAIL verdict, fix-and-resubmit

This is the second invocation shape: keyed off a **PR number**, it is the consumer the
gate FAIL markers were written for (`gh-issue-intake-formats.md` §5/§6/§6.5 name write-code the
reader of `review-code: FAIL @ <sha> — not merge-ready`, `review-doc: FAIL @ <sha> —
changes-requested`, and `review-skill: FAIL @ <sha> — changes-requested`, SHA-bound per ADR
0058). You take a PR that came back failed, apply exactly the enumerated
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

Do **not** act on the presence of any FAIL that ever existed. Resolve `review-code`,
`review-doc`, and `review-skill` in **separate namespaces** — three anchored regexes that never
cross-match — and take the **latest by timestamp** in each. This mirrors `ship-it` Step 2's
resolution exactly (the reading side of the same contract), **including its ACL author-gate**:
a marker comment counts as a verdict only from a `write+` repo collaborator, so a
self-authored or forged `review-(code|doc|skill): FAIL` is invisible (ADR
[0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)). The native-review path needs
no ACL gate — GitHub author-attributes reviews, so it is unforgeable.

```bash
PR=<the PR number you were handed>
# whose markers count as a verdict — GitHub's repo ACL, the same trust root ship-it Step 2 uses
# (ADR 0055): build the authorized set from THIS PR's marker authors holding write+ on the repo.
comments_file=$(mktemp)
gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file"
# every marker test below is emphasis-tolerant (leading \** absorbs review-code's bolding)
# per gh-issue-intake-formats.md §5 — the canonical matcher contract
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' "$comments_file")
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
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-code:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"

# latest decisive native review (APPROVED / CHANGES_REQUESTED) — folds into the code namespace
# (no ACL gate: GitHub author-attributes reviews, so this path is unforgeable). commit_id IS its bound SHA.
gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}'

# latest review-doc marker (doc namespace) — author-gated, anchored, never matches review-code/review-skill
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-doc:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"

# latest review-skill marker (skill namespace) — author-gated, anchored, never matches review-code/review-doc
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)"; "i"))]
    | sort_by(.created_at) | last
    | {body, at: .created_at,
       sha: (.body // "" | (capture("(?i)^\\s*\\**\\s*review-skill:\\s*(PASS|FAIL)\\s*@\\s*(?<s>[0-9a-f]{7,40})") // {s:null}).s)}' "$comments_file"
```

Resolve per namespace, latest-wins by timestamp, **then apply the SHA-staleness test** (ADR
[0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md), mirroring `ship-it` Step 2b):

- **review-code namespace** — the verdict is the **newest of {latest decisive review,
  latest review-code marker}**; its bound SHA is the marker's `@ <sha>` (or the review's
  `commit_id`). `CHANGES_REQUESTED` or `review-code: FAIL` is FAIL; `APPROVED` or
  `review-code: PASS` is PASS.
- **review-doc namespace** — the verdict is the **latest `review-doc` marker** by
  `created_at` (review-doc is comment-only — no native review). `review-doc: FAIL` is FAIL.
- **review-skill namespace** — the verdict is the **latest `review-skill` marker** by
  `created_at` (review-skill is comment-only — no native review). `review-skill: FAIL` is FAIL.
  A `review-skill: advisory` line (a blocking-set skill PR) carries no `@ <sha>` and is **not**
  a FAIL — it judges nothing to repair, so it's a clean no-op like a PASS.

**Act only when a namespace's latest verdict is FAIL *bound to the current head*.** A newer
FAIL is acted on even if an older PASS exists — but a FAIL whose `@ <sha>` is **not** the PR's
current head (`$CURRENT_HEAD`, by prefix-match either way), or that carries **no** `@ <sha>`
(a pre-0058 legacy marker), is **stale**: it judges code that has since changed, so do **not**
repair on it — report `nothing to repair (latest FAIL not bound to current head)` and stop.
A PR whose latest current-head verdict is PASS — or that has no current-head FAIL at all — is
**not repaired**. This keeps repair mode **idempotent**: re-running it on an already-fixed/PASS
PR, a no-FAIL PR, or a stale-FAIL PR is a clean no-op. If **more than one** namespace's latest
current-head verdict is FAIL (a mixed PR — e.g. code+doc, or skill+code), address **all** of
them in this round.

R1 resolves the **AC gate** — the marker (and the decisive native review folded into the
code namespace) is what decides whether there's anything to repair, and its `[FAIL]` table
is the AC work-list (Step R2). Line-anchored **inline review comments** are a *separate,
additive* input read in Step R2: they never substitute for the marker (a PR with no
current-head FAIL is still a clean no-op even if inline comments exist) and they don't
themselves gate — they fold into the same fix round as additional required fixes.

### Step R2 — Read the enumerated findings, fix exactly those

The FAIL marker comment (or `CHANGES_REQUESTED` review body) carries a **per-criterion
evidence table** — each unmet `### Acceptance criterion` (and, for `review-doc`, each unmet
hygiene check; for `review-skill`, each unmet rigor check) listed as a `[FAIL]`/`[UNVERIFIABLE]`
line with what's missing. Read the full body of the resolving comment/review and treat **those
enumerated findings as the AC work list** — fix exactly what they name (the inline-comment fixes
below are additive to this list, not a substitute for it):

```bash
# the full body of the latest FAILing review-code marker (swap review-code→review-doc/review-skill per namespace)
# author-gated against the ACL-derived $authorized set R1 already built — only a real reviewer's findings are your work list
# marker test stays emphasis-tolerant (leading \** absorbs review-code's bolding) per gh-issue-intake-formats.md §5
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-code:\\s*FAIL"; "i"))]
    | sort_by(.created_at) | last | .body' "$comments_file"
```

#### A review-appended AC is an ordinary `[FAIL]` row — no special parser (ADR 0079)

A `review-*` gate may **append** a new acceptance criterion to the linked issue when it spots
an in-scope defect the issue's AC never named (the reviewer-append surface — its shape, its
provenance tag, and its four fences live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §2, the single source; cite
it, don't re-derive it). On the **drain** side that AC needs **no new machinery**: it is
written in the exact checkbox-bullet shape the rest of the list uses, so when the next review
verifies the issue against its (now-longer) AC list, an unmet appended criterion surfaces in
the resolving FAIL marker's `[FAIL]` table **identically** to any triage-authored one. You
already fixed that table above — a review-appended `[FAIL]` row is fixed by the **same**
repair, with **no parallel path**.

The one thing you *do* honor is the criterion's **provenance tag** — the trailing
`<!-- ac:<gate> pr:#NNN round:K -->` comment §2 defines. It is not a parser hook (the row is
the same checkbox shape with or without it); you read it only for two things: the audit trail
(Step R3 records *that a fix addressed a review-authored AC* — `ac:review-*`, as opposed to an
upstream `ac:triage`/`ac:plan-epic`/untagged one) and the **frozen-after-round-K** fence
(Bounding below reads the tag's `round:K` to decide escalate-vs-loop). A criterion with **no**
`ac:` tag, or an `ac:triage`/`ac:plan-epic` tag, is upstream-authored and drains exactly as it
always has — the tag changes nothing about *how* you fix the row, only how you log it and when
the freeze fence trips.

#### Also fold in line-anchored inline review comments (additive, not the gate)

The marker's `[FAIL]` table is the **AC gate** and remains so — but humans and review bots
leave their most concrete, fixable feedback as **inline review comments** anchored to a
specific `path`+`line` on the diff (`GET repos/$REPO/pulls/$PR/comments`), and as
**decisive native review bodies** (`GET .../pulls/$PR/reviews`, already resolved in R1).
Repair mode reads these too and folds them into the **same** fix round — *in addition to*
the marker findings, never as a replacement. **Precedence:** if the marker (R1) has no
current-head FAIL, there is nothing to repair and inline comments alone do **not** trigger a
repair round; once a FAIL round is open, every in-scope inline comment is a **required fix**
alongside the `[FAIL]` table.

**Reviewer scoping** — an inline comment counts as a required fix only when its author is
**either**:

- a **`write+` repo collaborator** — the same GitHub-ACL floor ADR
  [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)
  applies to marker authority (reuse the per-author `collaborators/<login>/permission`
  check from R1); **or**
- the **`copilot-pull-request-reviewer[bot]`** review bot, included **explicitly** by
  login. Review bots don't hold collaborator permissions, so the `write+` floor would
  silently drop them — and Copilot is already the bot commenting on these PRs (#383), so its
  line-level findings are exactly the signal this path exists to action. No other bot is
  in scope; widen the allow-list deliberately, never by default.

Anything outside that set (a `read`-only human, a drive-by bot) is **advisory** — surface it
but don't treat it as a required fix.

**Head-binding (ADR 0058 staleness, applied to inline comments).** A comment whose anchor
no longer exists at the PR's current head is **stale** and is skipped: GitHub nulls the
comment's `line` (and `position`) once the anchored hunk is outdated, so an in-scope comment
is actionable only when its `line` is non-null. This is the inline-comment analog of R1's
`@ <sha>` staleness test — repair never chases feedback bound to code that has since changed.

```bash
ME=$(gh api user --jq '.login')   # don't action your own author-side replies
# fetch into a var, then pipe to standalone jq — gh's --jq takes no --argjson, and this reuses
# the same $authorized set R1/R2 already built (same pattern as the marker work-list above)
inlineComments=$(gh api "repos/$REPO/pulls/$PR/comments?per_page=100")
# in-scope, still-anchored inline review comments → your additive fix list (id+path+line+body)
jq --argjson authorized "$authorized" --arg me "$ME" \
  '[ .[]
     | select(.line != null)                                  # non-null line ⇒ still anchored to current head (ADR 0058)
     | select(.user.login != $me)                             # skip self-authored thread replies
     | select((.user.login | IN($authorized[]))               # write+ collaborator (ADR 0055), or…
              or .user.login == "copilot-pull-request-reviewer[bot]")  # …the explicitly-included review bot (#383)
   ] | .[] | {id, path, line, body}' <<<"$inlineComments"
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
# mis-attribution guard (Step 3.5): confirm the PR's linked issue #N is MINE before touching its
# branch — so a mis-dispatched repair never pushes to another agent's live PR (the #1404 class).
# In orchestrated repair the original claim token is threaded as MY_CLAIM (ADR 0115 §3 delegated own).
claim_is_mine "$N" || { echo "refusing to repair PR #$PR — its linked issue #$N is not my claim (Step 3.5)"; exit 1; }
wt_preflight && git switch <the PR's head branch>   # gate the branch switch ([per-mutation preflight]); gh api .../pulls/$PR --jq '.head.ref'
# apply the fixes addressing exactly the enumerated findings
```

Repair mode runs in a worktree too, so re-run the Step-4 opening preflight (and capture `WT`)
before this switch, then gate every later `git commit`/`git push` on `wt_preflight` exactly
as the initial build does.

Ground the fixes the same way the initial build does — ADRs in `.decisions/` for the *why*,
patterns in `.patterns/` for *how the code is shaped* — and run `pnpm typecheck` / the test
suite plus **`pnpm lint:worktree`** from Step 4 (never `pnpm lint` / `biome check .`,
which self-no-ops from inside a worktree — #236, #553) before pushing, exactly as Step 4 requires.

### Step R3 — Push, post a progress comment, then stop (the gate re-runs)

Push the fix to the same branch and post a **format-3 progress comment** on the linked
issue (Completed = the findings you addressed; Decisions/Gotchas; Next = "re-review
requested"). **Where a fixed `[FAIL]` row was a review-appended AC** (an `ac:review-*`
provenance tag, §2) rather than an upstream triage/plan-epic criterion, **say so in
Completed** — name it as a review-authored AC and cite the originating PR/round from its tag.
This keeps the audit trail of the time-varying AC contract complete (ADR 0079 Consequences):
the next reader can see which criteria the *reviewer* added and that the loop drained them,
not just that boxes were checked. The same note carries into the Step 7 epic handoff
("Affects siblings") for a sub-issue, since a reviewer-added criterion is exactly the kind of
cross-task signal a sibling should know the gate now enforces. Pushing new commits is what
makes the **stateless** gate re-run — you do **not** re-trigger or self-approve it:

```bash
# re-assert the mis-attribution guard (Step 3.5) before the resubmit push — a between-calls cwd
# reset can't move the claim, but the guard is MANDATED before every number-targeting mutation,
# exactly as wt_preflight is before every git op; gate both the push and the progress comment.
claim_is_mine "$N" || { echo "refusing to push/comment — PR #$PR linked issue #$N not my claim (Step 3.5)"; exit 1; }
wt_preflight && git push origin HEAD   # gate the push ([per-mutation preflight])
gh api repos/$REPO/issues/$N/comments -f body="$(cat /tmp/write-code-repair-progress.md)"
```

**Acknowledge the inline threads you addressed** so the loop is visible to the reviewer who
left them. For each in-scope inline comment you fixed, post a **threaded reply** naming what
you changed (REST, on the same review-comment thread):

```bash
# reply on the inline comment thread you addressed ($CID = the comment id from R2)
gh api -X POST "repos/$REPO/pulls/$PR/comments/$CID/replies" \
  -f body="Addressed in <short-sha>: <one line on the fix>."
```

A reply is the acknowledgement this skill performs. **Resolving** the thread (collapsing it)
is a GraphQL-only mutation (`resolveReviewThread`), and the org's Projects-classic
integration breaks GraphQL (see the top-of-skill REST-only rule), so repair mode does **not**
resolve threads — the reviewer (or `ship-it` on merge) resolves; the reply is what closes the
loop on write-code's side.

Then **stop.** The independent re-review re-gates the fix and lands a fresh verdict; that
is the firewall. write-code does **not** run a review skill on the resubmitted head, does
**not** write a PASS marker, does **not** approve, and does **not** merge — merge is
`ship-it`'s sole authority (and for a control-plane `.claude`/`.github` PR, a *human's*; see
the guardrail below). The push **is** the only re-trigger the stateless gate needs; a
**separate** reviewer picks the new head up and judges it. Report which findings you addressed
and that you handed the PR back to the gate.

### Bounding — cap at 3 rounds, then escalate

Repair is **bounded at N = 3** fix → re-review rounds on the same PR, to avoid looping
forever on a finding it cannot resolve. Count your rounds from the PR's history — a "round"
is one (gate FAIL → your fix-push) pair. Count **rounds, not markers**: a mixed PR that FAILs
in *multiple* namespaces in the same review pass is **one** round, not several. Identify
a review pass by **timestamp adjacency, not a wall-clock bucket**: cluster the FAIL markers
and start a new round only when the gap to the previous FAIL exceeds a threshold (`120s`
below). The markers of one multi-namespace pass land seconds apart (back-to-back `gh api`
posts) so they cluster into one round regardless of which side of a minute boundary they
fall on; two *genuine* rounds are always separated by your fix-push + an independent
re-review (minutes at least), so they never collapse into one. (A fixed `created_at[:16]`
minute bucket gets both of these wrong: it splits one pass straddling `:59`/`:00` into two
rounds — premature escalation — and merges two real rounds that share a minute into one —
the cap fails to bind and the loop runs past N=3.) Same ACL author-gate as Step
R1 (reuse its `$comments_file` + `$authorized`) — only a real reviewer's FAIL counts toward the cap:

```bash
# how many distinct gate-FAIL ROUNDS has this PR already accrued (both namespaces)?
# cluster FAIL markers by timestamp gap: a new round starts only when >120s separates two
# FAILs, so a code+doc pass (seconds apart) is one round and two real rounds (fix-push +
# re-review apart) are two — grid-free, so no minute-boundary split or same-minute merge.
jq --argjson authorized "$authorized" \
   '[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*FAIL"; "i"))
         | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
    | sort
    | reduce .[] as $t ({n:0, prev:null};
        if (.prev == null) or ($t - .prev) > 120
        then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
    | .n' "$comments_file"
```

If this PR has **already had 3 FAIL→fix rounds** (you'd be pushing a 4th fix against a 4th
FAIL), **stop fixing and escalate** instead of pushing again:

```bash
# mis-attribution guard (Step 3.5): escalation is a number-targeting mutation on #N (comment +
# relabel), reachable as a fresh stateless repair's FIRST mutation when the PR is already at the
# N=3 cap (write-code escalates INSTEAD OF running R2/R3, so the R2/R3 guards never fire). Gate it
# fail-closed so a mis-dispatched repair never comments-on/relabels another agent's live issue (the
# #1404 class — the relabel is more disruptive than a comment).
claim_is_mine "$N" || { echo "refusing to escalate PR #$PR — its linked issue #$N is not my claim (Step 3.5)"; exit 1; }
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

### Freeze-after-round-K — a review-appended AC at the cap escalates, never loops (ADR 0079)

The reviewer-append surface (§2) lets a gate add an AC mid-life, so the AC list a worker
drains is **time-varying** — and an AC appended *late enough* could keep the loop alive past
its bound (append a fresh criterion every round, fixer never catches up). §2's **fourth fence**
closes that on the drain side, and binds **K to the same N=3 round cap above** — there is no
second tunable: `K = N = 3`. Cite §2 fence 4 as the single source; this is its drain-side
enforcement.

The fence triggers off the appended AC's **`round:K` provenance tag** (§2), which records the
round-cluster index the gate appended it in. An appended criterion (an `ac:review-*` `[FAIL]`
row in this round's table) is **frozen — not drainable — when it was appended in or after the
final repair round**, i.e. its tagged `round` ≥ `N` (= 3). Concretely, for each
`ac:review-*` `[FAIL]` row you are about to fix, read its `round:K`:

- **`round < 3`** — it was appended with a repair round still left to drain it: fix it in this
  round like any other `[FAIL]` row (the Step R2 drain), no freeze.
- **`round >= 3`** — it was appended **in or after** the final round, so there is **no round
  left to drain-and-re-verify it within the bound**. Do **not** fix-and-push it (that push
  would be the out-of-budget loop iteration the cap exists to forbid). **Escalate to a human**
  via the **same escalation path** as the N=3 cap above — name the frozen appended criterion,
  hand the PR back, surface for re-triage:

```bash
# does this round's resolving FAIL table carry a review-appended AC tagged at/after the final round?
# the row is the ordinary checkbox shape; the tag is the only thing read here (no new parser)
# $FAILBODY = the resolving FAIL marker body from R2; grep the provenance tags it carries
echo "$FAILBODY" | grep -oE '<!-- *ac:review-[a-z]+ +pr:#[0-9]+ +round:[0-9]+ *-->' | while read -r tag; do
  K=$(printf '%s' "$tag" | grep -oE 'round:[0-9]+' | cut -d: -f2)
  [ "$K" -ge 3 ] && echo "FROZEN appended AC ($tag) — appended in/after final round; escalate, do not loop"
done
```

If **any** `ac:review-*` row in the current FAIL table is frozen (`round >= 3`), take the
**escalation path** (the same `### Repair escalation` comment + `status:needs-triage` label as
the N=3 block — and therefore the **same `claim_is_mine "$N"` fail-closed gate** that block
carries, MANDATED before its comment+relabel exactly as in the N=3 case: a frozen-AC escalation
is just as reachable as a mis-dispatched repair's first mutation, so it must not comment-on or
relabel an issue whose claim isn't mine), naming the frozen appended criterion as the still-open
finding and noting it was appended in/after the final round — then **stop, do not push**. The escalation comment's
"Needs a human decision" framing fits exactly: a criterion that arrived with no budget left to
drain it is the human's call (accept the PR as-is, extend the AC's life by a fresh triage, or
drop the criterion). This keeps **append-rate bounded by fix-rate** — a gate cannot keep a
bounded loop alive forever by appending fresh criteria, because the last-round append escalates
instead of re-looping. A non-frozen appended AC (`round < 3`) drains normally; a frozen one is
indistinguishable from "still FAILing after the cap" to the picker, so the same Step-1
`ROUNDS >= 3` cap-exclusion steps a future run over the PR — no silent re-pick, no re-loop.

### Guardrails (repair mode)

- **Never merge.** Repair mode pushes and hands back to the gate; the merge is `ship-it`'s
  (PASS → merge), and for a control-plane `.claude`/`.github` PR a **human's** — `ship-it`
  *refuses* to auto-merge blocking-set PRs and `review-doc` is advisory-only on them (ADR
  [0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)). **This very edit is such a PR:
  a `.claude/**` change `ship-it` will refuse to auto-merge, merged by hand.** Repair mode
  never weakens that refusal.
- **Never review your own resubmit (split-role firewall).** After pushing the fix you
  **stop** — you do **not** run `review-code`/`review-doc`/`review-skill` on the new head, post
  a `review-(code|doc|skill): PASS`/`FAIL` marker, or open a native PR review on it. The fix is
  re-gated by an **independent** reviewer; the bias firewall lives at the *review* step, and
  write-code occupying both seats is exactly what defeats it (#664). The push is the only
  re-trigger; a separate reviewer judges the new head.
- **Same branch, never a new one.** Fix on the PR's existing head branch so the PR and its
  gate history stay intact.
- **Mis-attribution guard before every push/comment ([Step 3.5](#mis-attribution-guard)).**
  Confirm the PR's linked issue `#N` carries **your own** claim (`claim_is_mine "$N"` — the
  orchestrator threads the original claim as `MY_CLAIM` for delegated repair, ADR 0115 §3) before
  the R2 branch switch and the R3 push/comment, so a mis-dispatched repair never clobbers another
  agent's live PR (the #1404 class). Fail-closed: an absent or foreign claim refuses.
- **Idempotent.** Re-running on an already-fixed / PASS PR (one with no latest FAIL, or one
  whose latest FAIL is bound to a now-stale head) is a clean no-op (Step R1).
- **SHA-bound verdicts (ADR [0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)).**
  Act only on a FAIL bound to the PR's **current head** — a FAIL whose `@ <sha>` is stale (or
  absent) judges code that has since changed, so repair mode ignores it. This mirrors
  `ship-it` Step 2b's staleness refusal on the reading side.
- **All three namespaces.** Handle `review-code: FAIL @ <sha>` (§5), `review-doc: FAIL @ <sha>`
  (§6), **and** `review-skill: FAIL @ <sha>` (§6.5) — latest current-head verdict per namespace —
  not just `review-code`. A skill PR's FAIL lands in the `review-skill` namespace (ADR 0073).
- **Author-gated verdicts.** A marker counts only from a `write+` repo collaborator —
  the same GitHub-ACL gate `ship-it` Step 2 applies before the marker regex, so a forged or
  self-authored `review-(code|doc): FAIL`/`PASS` can neither trigger spurious repair nor
  mask a real verdict (ADR [0055](https://github.com/kamp-us/phoenix/blob/main/.decisions/0055-acl-sourced-review-authz.md)).
- **Inline comments are additive, never the gate (Step R2).** Repair also folds in
  line-anchored inline review comments (`pulls/$PR/comments`) as *required fixes alongside*
  the marker's `[FAIL]` table — never as a substitute: with no current-head marker FAIL there
  is nothing to repair, inline comments alone don't open a round. In scope are comments from
  a **`write+`** author (ADR 0055 floor) **or** the explicitly-named
  `copilot-pull-request-reviewer[bot]`; out-of-scope authors are advisory only. A comment with
  a **null `line`** is stale (its anchor no longer exists at the current head) and is skipped —
  the ADR 0058 staleness test applied to inline anchors. Addressed threads get a REST reply
  (resolve is GraphQL-only → out of reach here).
- **Review-appended ACs drain like any `[FAIL]` row — no new parser (ADR
  [0079](https://github.com/kamp-us/phoenix/blob/main/.decisions/0079-reviewer-authored-acceptance-criteria.md),
  §2).** A gate-appended criterion (`ac:review-*` provenance tag) surfaces in the resolving
  FAIL table in the **same checkbox shape** as a triage-authored one and is fixed by the
  **same** Step R2 repair — the tag is read only for the audit trail (Step R3 logs that a fix
  addressed a review-authored AC) and the freeze fence (below).
- **Freeze-after-round-K (§2 fence 4, `K = N = 3`).** A review-appended AC tagged
  `round >= 3` was added in/after the final repair round, so there is no budget left to
  drain-and-re-verify it within the bound — **escalate it via the same N=3 escalation path,
  never fix-and-push**. Binding K to the existing N=3 cap (no second tunable) keeps
  append-rate bounded by fix-rate so the loop still terminates (Bounding, Freeze-after-round-K).
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
then **record it via the in-repo `/adr` skill** (at `../adr/SKILL.md` —
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
deliverable is a **diagnosis**, and then *routing* its findings. Usually that routing is a
closing comment plus `report` residue (the residue path below); the one exception is when
the diagnosis *is* a trivial fix, which **collapses into a single PR** — check that gate
first, then fall through to the residue path if it doesn't hold.

#### Bounded collapse — when the fix is trivial, open one PR instead of residue (ADR 0070)

When the investigation resolves into a **fix** (not just a finding), check the
**bounded-collapse gate** before taking the residue path. The gate is the four AND-ed bounds
stated once in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §8 — the
single source of this rule; cite it, don't restate the bounds. In short: ① single concern,
narrowly scoped · ② no new behavior/surface · ③ no contract/control-plane change
(`.claude/**`, `.github/**`, gate-critical skill) · ④ cause established + fix unambiguous.

If — and **only if** — the fix clears **every** one of the four bounds, **collapse**:
implement the fix on a branch and open a PR with `Fixes #N` in the **same run** (Steps 4–7
as written), skipping the `report → triage` intake hops. Make the collapse **explicit, not
silent** — the PR body states it is a collapsed investigation, links the issue, and
**carries the diagnosis** (the verdict the closing comment would otherwise have held) so
`review-code` verifies the fix against the named cause as its acceptance criterion.
Verification is **not** collapsed: the PR is independently `review-code`-gated like any
other; only the *intake* hops are skipped. Post the format-3 progress comment (Step 6)
recording the cause and that this is a collapsed investigation, and — for a sub-issue — the
Step 7 handoff.

The gate is **hard and AND-ed**: if the fix fails **any one** bound — a multi-file change, a
new surface, a control-plane edit, or a lingering design choice — it is **not** a collapse
case, so **fall back to the diagnosis-and-`report`-residue path below** (file the fix as
fresh residue, unchanged). Bound ③ means a control-plane fix is *never* collapse-eligible:
it takes the full path and a human merge (ADRs
[0053](https://github.com/kamp-us/phoenix/blob/main/.decisions/0053-control-plane-boundary.md)
/ [0065](https://github.com/kamp-us/phoenix/blob/main/.decisions/0065-gate-critical-skills-are-blocking.md)).

#### Residue path — diagnosis + routed findings (the default, and the collapse-gate fallback)

When the gate above does **not** hold (no fix, or the fix fails a bound), the deliverable is
a **diagnosis** and the *routing* of its findings, not a feature branch:

1. **Post the diagnosis as the closing comment** on the issue: what you found, the
   root cause (or "could not reproduce" / "not a real problem" with the evidence), and
   the verdict. This comment *is* the close — investigations don't merge a PR to close;
   they close because the question is answered. Close it:

   ```bash
   # closing #N is a number-targeting mutation — gate it on the mis-attribution guard (Step 3.5)
   # so a mis-attributed number never closes another agent's live issue (the #1404 class).
   claim_is_mine "<N>" || { echo "refusing to close #<N> — not my claim (Step 3.5)"; exit 1; }
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
  implement→PR→progress→handoff (Steps 4–7) or the type-routed path — **gating every
  number-targeting mutation on the [mis-attribution guard](#mis-attribution-guard) (Step 3.5:
  verify the target carries my own claim, fail-closed)** — and **hard-stop at
  PR-open (Step 8) — hand the review gate to a separate reviewer; never review your own PR.**
  Report a short ledger: the issue picked (and why — bucket + age, the milestone tiebreaker or
  `work milestone N` scope if either applied, or the sub-issue eligibility derivation), the
  branch and PR opened (or the ADR/diagnosis for a decision/investigation), a pointer to
  the progress comment, and that the gate is left to a separate reviewer.
- **Repair** (PR number): resolve the PR's latest verdict per namespace (Step R1) and, if
  it's FAIL, fix the enumerated marker findings — **including any review-appended AC, drained
  as an ordinary `[FAIL]` row (ADR 0079, §2)** — **plus the in-scope line-anchored inline
  review comments** (Step R2) on the same branch, push, reply on the threads you addressed,
  post progress (noting any review-authored AC you drained), and stop (Steps R1–R3) — or
  escalate if the PR has hit the N=3 cap **or carries an AC appended in/after the final round
  (freeze-after-K)**. Report which findings you addressed (or `nothing to repair` for a
  PASS/no-FAIL PR), and that you handed the PR back to the gate. **Never merge** in either mode.

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
[0047](https://github.com/kamp-us/phoenix/blob/main/.decisions/0047-review-plan-gate.md)); your output —
a claimed issue, a PR with `Fixes #N`, progress comments, and an epic handoff note — is
exactly what `review-code`/`review-doc`/`review-skill` read to verify the work against its
acceptance criteria before merge. The loop closes back on you: when a gate lands a **FAIL** marker
(`review-code` §5, `review-doc` §6, or `review-skill` §6.5), *you* are its consumer — [Repair mode](#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit)
reads the findings, fixes, and re-submits for an independent re-gate, while `ship-it` stays
the sole owner of PASS → merge. You also lean on two sibling skills inside type routing:
`/adr`
([`../adr/SKILL.md`](../adr/SKILL.md)) for `type:decision`, and [`report`](../report/SKILL.md) for an
investigation's actionable residue.
