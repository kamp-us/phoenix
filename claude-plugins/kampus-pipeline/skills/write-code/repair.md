# write-code — Repair mode

`write-code`'s **second invocation shape**, split out of [`SKILL.md`](SKILL.md) so an initial
build never loads it (#4404). Read this file **only** when you were handed a **PR number**; an
issue number (or no argument) is initial-build mode and stays entirely in `SKILL.md`.

**This file is not standalone — it runs on top of `SKILL.md`'s shared preamble, and only that
part of it.** Read these three sections of [`SKILL.md`](SKILL.md) first, then come straight back
here; Steps 1–7 there are the *initial* build and do not apply to a repair.

| Read first | What repair mode takes from it |
| --- | --- |
| [All GitHub ops via `gh api` REST — never GraphQL](SKILL.md#all-github-ops-via-gh-api-rest--never-graphql) | the literal-path execution convention (ADR 0232), and §ZS — a script's non-zero exit is UNKNOWN, never an answer |
| [Step 3.5 — the mis-attribution guard](SKILL.md#mis-attribution-guard) | `MY_CLAIM` and `scripts/step3_5-claim-is-mine.sh`, which Step R0 gates the entire repair on |
| [Step 4's opening preflight and `scripts/step4-wt-preflight.sh`](SKILL.md#per-mutation-preflight) | the worktree assertion R2's branch switch and R3's push are each gated on |

---

## Repair mode — consume a gate FAIL verdict, fix-and-resubmit

This is the second invocation shape: keyed off a **PR number**, it is the consumer the
gate FAIL markers were written for (`gh-issue-intake-formats.md`'s relationship table names write-code the
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

### Step R0 — A repair dispatch MUST carry a claim token (no token ⇒ refuse, never a judgment call)

Repair is the dispatch class the mis-attribution guard was **inert** on. A repair re-drive
arrives on a lane someone else opened — often a *new* engine session re-driving a lane whose
original claimant is gone — so the earliest authorized claim on the linked issue is, by default,
**not this run's session**. With no token threaded, the mis-attribution guard can neither authorize nor
refuse the repair on evidence, and two coders on the same wave resolved that ambiguity in
**opposite** directions (one wrote to the issue, one withheld its progress comment — #3751).
Fail-open ambiguity is the defect; both halves below close it.

**The dispatcher's obligation.** Whatever dispatches a repair — the orchestrator
(`.claude/workflows/drive-issue.js`, which threads the token it claimed pre-spawn) or any other
engine re-driving a stalled lane (which **claims the lane in its own session first**, via
`pipeline-cli tracker claim <issue>`, and threads *that* token) — **MUST** thread the lane's
claim token into the repair prompt, exactly as the initial-build dispatch does (ADR 0115 §3
delegated ownership). There is no repair-specific token mechanism: it is the same
`THREADED_CLAIM_TOKEN` contract.

**Your obligation, and the one thing you may not do.** Resolve `MY_CLAIM` per
[Step 3.5](SKILL.md#mis-attribution-guard) and gate the repair on `step3_5-claim-is-mine.sh "$N"` against the PR's
linked issue. If it refuses — no token was threaded, or the threaded token is not the earliest
**live** authorized claim — **STOP and report the refusal.** You may **not** proceed on the
strength of an explicit-looking dispatch brief, or on independently corroborating
PR → branch → `Fixes #N` → the FAIL verdict. That corroboration says the *dispatch was
coherent*; it says nothing about *who owns the lane*, which is the only question the guard asks.
Talking yourself past the refusal is the exact failure this step removes: the outcome is
**deterministic — threaded ⇒ proceed, unthreaded ⇒ refuse** — and the refusal is a routed
blocker for the dispatcher (it must claim and re-dispatch), never yours to override.

**Why a dead claimant no longer blocks a legitimate re-drive.** The old resolution asserted
against the *earliest* authorized claim, full stop — so a dead session's marker shadowed every
later legitimate claim forever, and an engine that correctly re-claimed the lane in its own
session *still* failed the guard. `pipeline-cli claim is-mine` now treats a claim whose claimant
is **provably dead** as **superseded** (ADR 0191 presence liveness — the claimant's session
process is stamped on the marker and probed), so the earliest *live-or-indeterminate* claim wins.
Supersession requires **positive evidence of death**: an unstamped marker, a claim from another
host, or an unprobeable pid stays indeterminate, still counts, and the guard still refuses — doubt
never evicts a slow-but-live agent (the hazard `gh-issue-intake-formats.md` §7's deferred-reclaim
note protects).

### Step R1 — Resolve the latest verdict per namespace (mirror `ship-it` Step 2)

Do **not** act on the presence of any FAIL that ever existed. Resolve `review-code`,
`review-doc`, and `review-skill` in **separate namespaces** and take the **latest current-head
verdict** in each — the exact resolution `ship-it` Step 2 reads. That resolution (the ADR-0055
write+ author-gate so a self-authored or forged `review-(code|doc|skill): FAIL` is invisible, the
latest-wins pick, and the ADR-0058 SHA-staleness refusal) is owned by `pipeline-cli verdict read`,
so R1 delegates to the verb rather than re-deriving it (#2102) — its unit tests are the contract.
The native decisive review that folds into the code namespace is the one thing the verb does not
resolve (it reads only marker comments); it needs no ACL gate — GitHub author-attributes reviews, so
that path is unforgeable — so R1 keeps just that fold inline. The fold is **newest-WRITTEN wins**,
matching `ship-it` Step 2: the code verdict is the newest of {latest decisive review, in-force
`review-code` marker}, so a more recently written `APPROVED` clears an older FAIL rather than the FAIL
standing forever. Compare the review's `submitted_at` against the verb's `writtenAt`, never the marker
comment's `created_at` — an in-place upsert leaves `created_at` at the slot's open time, so a review is
systematically over-ranked against a marker rewritten after it (#4200).

```bash
# <PR> is the PR number you were handed. The script does all of R1 in one process: it builds the
# write+ author-set (ADR 0055) the inline-comment gate and the N=3 round count reuse, derives §CP-ness
# through §CPREAD's `cp_changed_files`, delegates each (PR, gate) FAIL-bound-to-head resolution to
# `pipeline-cli verdict read` (author-gate + latest-wins + ADR-0058 SHA-staleness in one exit code),
# and folds the native decisive review into the code namespace by NEWEST-WRITTEN wins.
#
# stdout is five `KEY=value` lines: `REPAIR_SCRATCH=`, `VERDICT_UNKNOWN=`, `CODE_FAIL=`, `DOC_FAIL=`,
# `SKILL_FAIL=`. `REPAIR_SCRATCH` is the §SP per-run directory this step WRITES the author set, the
# comment stream and the three verdict payloads into — that is how Bounding, R2's FAIL-body read and
# the inline-comment fold reach state R1 resolved, since no shell variable survives to the next Bash
# call. Each of them refuses if R1 never wrote it: absent state is UNKNOWN, never an empty set.
#
# A non-zero exit means NO verdict was resolved (127 = the CLI never ran) — UNKNOWN, and never
# "nothing to repair".
bash ./.claude/.pipeline/skills/write-code/scripts/stepR1-verdicts.sh <PR> || exit 1
```

**A namespace that did not resolve at all is UNKNOWN, not "no FAIL" — defer, don't skip.** If
`VERDICT_UNKNOWN=1` (a `verdict read` that printed no outcome JSON — a transport/5xx failure rather
than a verdict), stop and report `verdict unresolved (GitHub read failed) — deferring, not skipping`.
Reading an unresolvable namespace as "nothing to repair" would silently drop a real repair; a
deferred run is retried, a skipped one is lost.

**Act only when a namespace's latest verdict is FAIL *bound to the current head*** — i.e. `CODE_FAIL=1`
(a current-head `review-code: FAIL` marker per `verdict read`, or a current-head `CHANGES_REQUESTED`
review), `DOC_FAIL=1`, or `SKILL_FAIL=1`. `verdict read` already encapsulates latest-wins **and** the
SHA-staleness refusal: a newer FAIL is acted on even if an older PASS exists, but a FAIL whose `@ <sha>`
is not the current head (or carries no `@ <sha>` — a pre-0058 legacy marker) resolves `stale`/`sha-less`,
exits non-zero, and is **not** repaired — report `nothing to repair (latest FAIL not bound to current
head)` and stop. A `review-skill: advisory` line (a blocking-set skill PR) is never a FAIL: without
`--cp` it resolves `none` (no first-line polarity) and with `--cp` it resolves the §CP pass, so both
are a clean no-op. Passing `--cp` is what makes the §CP case *correct* rather than merely quiet — a
current-head all-PASS advisory then supersedes an older same-head FAIL that a body-only repair
already discharged, instead of leaving that FAIL resolvable forever (#4049). This keeps repair mode
**idempotent**: re-running it on an already-fixed/PASS PR, a no-FAIL PR, or a stale-FAIL PR is a clean
no-op. If **more than one** namespace resolves FAIL (a mixed PR — e.g. code+doc, or skill+code), address
**all** of them in this round.

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
# name the namespace whose FAIL you are draining — `code` (the default), `doc` or `skill`. It reads
# R1's payload out of the §SP scratch dir R1 wrote, so run R1 first; an absent payload refuses.
# stdout is `CID=<comment id>` and `FAILBODY_FILE=<path>`, then the FAIL marker body itself. `$CID` is
# what R3's thread reply is addressed at; the body file is what the freeze fence reads.
bash ./.claude/.pipeline/skills/write-code/scripts/stepR2-fail-body.sh <PR> code || exit 1
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
# stdout IS the additive fix list, one {id, path, line, body} object per in-scope comment. It reads
# the write+ author set R1 wrote to the §SP scratch dir; an absent set refuses (R1 never ran here).
bash ./.claude/.pipeline/skills/write-code/scripts/stepR2-inline-comments.sh <PR> || exit 1
```

For context on *what the PR was supposed to do*, resolve the **linked issue** via the PR
body's `Fixes #N` and re-read its `### Acceptance criteria` (the same checklist the gate
verified) and the progress trail:

```bash
# stdout is `N=<the PR's linked issue>` first, then that issue's body and comment stream. `$N` is the
# number every later repair mutation is claim-gated on, so an unresolvable `Fixes #N` refuses.
bash ./.claude/.pipeline/skills/write-code/scripts/stepR2-linked-issue.sh <PR> || exit 1
```

Check out the **existing PR branch** and fix on it — **no new branch** (a new branch would
orphan the PR and the gate's history):

```bash
# <N> is stepR2-linked-issue.sh's `N=` line; the head branch is `gh api .../pulls/<PR> --jq .head.ref`.
# stdout is `WT=<root>` — the tree the switch and rebase happened in, and the tree R3's push must be
# addressed at. Non-zero ⇒ nothing was switched, or the rebase stopped on a conflict (resolve it in
# $WT and re-run; never `git rebase --abort`).
bash ./.claude/.pipeline/skills/write-code/scripts/stepR2-branch-rebase.sh <PR> <N> <the PR's head branch> || exit 1
# then apply the fixes addressing exactly the enumerated findings
```

Repair mode runs in a worktree too, so re-run the Step-4 opening preflight (and capture `WT`)
before this switch, then gate every later `git commit`/`git push` on `step4-wt-preflight.sh` exactly
as the initial build does.

#### The head branch is usually pinned by the build lane's leftover worktree — the sanctioned path

A build lane's worktree is not released when its lane finishes, so by the time you repair, the PR's
head branch is normally **still checked out there** and git refuses a second checkout of it
(`fatal: '<branch>' is already checked out at …`). **This is the routine case, not an edge case**, and
the step above already handles it — **do not improvise past it.** Two lanes that improvised on the
same night took different routes, and one committed on a **detached checkout**, which silently cost
both the rebase onto latest `origin/main` *and* `verified-push` (which resolves a detached HEAD to
`UNKNOWN` and pushes nothing, so that lane hand-rolled its own refspec push and `ls-remote` check —
#4826).

`stepR2-branch-rebase.sh` classifies what holds the branch and routes on it, inside **your own**
`wt_preflight`-resolved worktree, and **removes no worktree in any case**:

| What holds the head branch | What the step does |
| --- | --- |
| Nothing | plain `git switch` |
| **Your own lane** already | nothing to switch — a re-run after a co-checkout is a clean no-op |
| **Another lane's leftover tree** | the sanctioned **co-checkout**: `git switch --ignore-other-worktrees` in your lane. That tree keeps its files, including uncommitted work; only the branch ref moves when you rebase |
| The **primary checkout** | **REFUSES** — rebasing would move a branch ref under the shared primary tree (the #2270 class). Remedy in the refusal: release the branch there, then re-run |
| A worktree stamped with **this session's** lane id | **REFUSES** — a sibling lane may still be building on it, and the rebase would move its HEAD mid-flight. Remedy: run the repair from that lane, or wait and re-run |

Two rules hold across all five rows, and neither is negotiable. **Never remove a worktree to free a
branch** — a build lane's tree can hold real uncommitted work, so eating one is strictly worse than
the bug; the co-checkout needs no removal at all, which is why it is the shape chosen. (Reaping the
accumulated leftover trees is a separate, undecided policy question — #4806 — and is deliberately not
solved here.) And **never detach HEAD to get past a refusal**: a detached repair skips the rebase and
leaves `verified-push` with no branch to verify. Every refusal above names its remedy on the refusal
line; if you hit one, take *that* remedy or stop and report — do not invent a sixth route.

**Freshen the base onto latest `origin/main` before you fix — surface a textual conflict at
code-time, not merge-time.** The repair branch still carries its **dispatch-time base**; if
`main` moved while the PR sat in the gate (other PRs merged) and touched the same lines, the
**textual merge conflict** doesn't surface until *merge* — when you (the coder) are long gone
and can't resolve it in-context. The `git fetch origin` above already updated `origin/main`, so
**`git rebase origin/main`** replays the branch onto the latest base **before** you apply the
fixes. Two outcomes:

- **Clean rebase** — the base was stale but non-conflicting; the branch is now current and you
  proceed to fix exactly as before. (ADR 0132's merge queue would catch a *behind-main* base at
  ship, but it does **not** auto-resolve a textual conflict — so freshening here is a genuine
  earlier catch, not a queue duplicate.)
- **Rebase hits a conflict** — a `main`-side change overlaps your branch's lines. This is the
  whole point: **resolve it now, in-context.** Reconcile each conflicted hunk (keeping both the
  incoming `main` change and your branch's intent), `git add` the resolved files, `git rebase
  --continue`, and only then apply the review findings on top. Do **not** `git rebase --abort`
  and push the stale base — that just re-buries the conflict until merge. Because a rebase moves
  the head, the eventual R3 push needs `--force-with-lease` (pass that flag to the R3
  `pipeline-cli verified-push` — never a bare push, which the corpus lint rejects), and
  the fresh re-review re-binds the verdict to the new head (the [rebase → re-review → ship is
  atomic](SKILL.md#a-rebase-invalidates-the-pass--rebase--re-review--ship-is-atomic) rule already covers
  this — the R3 push *is* that head-move, and the independent gate re-reviews it).

Ground the fixes the same way the initial build does — ADRs in `.decisions/` for the *why*,
patterns in `.patterns/` for *how the code is shaped* — and run the **pre-push typecheck**
(`pnpm typecheck`, the exact CI command — never a hand-rolled `tsc`; see Step 4) / the test
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

**A repair round that departed from anything APPENDS to `## Deviations` — it never rewrites it.**
The repair round is where the undisclosed call is most likely to be made and least likely to be
written down: you declined an optional reviewer suggestion, you fixed the finding a narrower way
than the verdict prescribed, you changed a pre-existing test the fix now contradicts, you pushed
past a hook. Walk the contract's seven classes ([§DEV](../gh-issue-intake-formats.md)) against
*this round's* diff, and if any fired, patch the PR body to add the entries under the existing
`## Deviations` heading, tagged `**(repair round K)**`, leaving every earlier entry standing — the
section is the PR's whole-life log, and a round that overwrites it erases the trail. A round that
departed from nothing adds nothing; it does **not** rewrite a prior round's entries to `None.`
(patch via REST — `gh api -X PATCH repos/$REPO/pulls/$PR -f body="…"` — since `gh pr edit` is
unreliable in this org).

```bash
# write the format-3 repair note to "$RUN_SCRATCH/repair-progress.md" FIRST.
bash ./.claude/.pipeline/skills/write-code/scripts/stepR3-push-and-note.sh <PR> <N> || exit 1   # push CONFIRMED on the remote, or nothing landed
```

**Acknowledge the inline threads you addressed** so the loop is visible to the reviewer who
left them. For each in-scope inline comment you fixed, post a **threaded reply** naming what
you changed (REST, on the same review-comment thread):

```bash
# <CID> is stepR2-fail-body.sh's `CID=` line — the thread this round answered
bash ./.claude/.pipeline/skills/write-code/scripts/stepR3-thread-reply.sh <PR> <CID> "Addressed in <short-sha>: <one line on the fix>." || exit 1
```

**Release the lane's claim before you stop**, exactly as Step 8 does for the initial build — the
repair round is over, and a claim left held is what makes the *next* repair dispatch on this PR
read `lost` (#3780; the observed stall was a repair refused by a claim whose run had finished):

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/step8-claim-release.sh <N> || exit 1   # the SAME script Step 8 runs — retract OUR OWN marker; never another session's
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
# stdout IS the round count, one integer; it reads the author set + comment stream R1 wrote to the
# §SP scratch dir. Empty stdout is UNKNOWN, never 0 rounds — read the status before the number.
bash ./.claude/.pipeline/skills/write-code/scripts/stepR-round-count.sh <PR> || exit 1
```

If this PR has **already had 3 FAIL→fix rounds** (you'd be pushing a 4th fix against a 4th
FAIL), **stop fixing and escalate** instead of pushing again:

```bash
# mis-attribution guard (Step 3.5): escalation is a number-targeting mutation on #N (comment +
# relabel), reachable as a fresh stateless repair's FIRST mutation when the PR is already at the
# N=3 cap (write-code escalates INSTEAD OF running R2/R3, so the R2/R3 guards never fire). Gate it
# fail-closed so a mis-dispatched repair never comments-on/relabels another agent's live issue (the
# #1404 class — the relabel is more disruptive than a comment).
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
bash ./.claude/.pipeline/skills/write-code/scripts/step3_5-claim-is-mine.sh "$N" \
  || { echo "refusing to escalate PR #$PR — its linked issue #$N is not my claim (Step 3.5)"; exit 1; }
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
# reads the resolving FAIL marker body stepR2-fail-body.sh wrote to the §SP scratch dir. stdout is one
# `FROZEN appended AC …` line per frozen criterion — EMPTY means none is frozen, which is why an
# absent body refuses rather than answer empty.
bash ./.claude/.pipeline/skills/write-code/scripts/stepR-frozen-ac.sh <PR> || exit 1
```

If **any** `ac:review-*` row in the current FAIL table is frozen (`round >= 3`), take the
**escalation path** (the same `### Repair escalation` comment + `status:needs-triage` label as
the N=3 block — and therefore the **same `step3_5-claim-is-mine.sh "$N"` fail-closed gate** that block
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
- **Mis-attribution guard before every push/comment ([Step 3.5](SKILL.md#mis-attribution-guard)).**
  Confirm the PR's linked issue `#N` carries **your own** claim (`step3_5-claim-is-mine.sh "$N"` — the
  dispatcher threads the lane's claim as `MY_CLAIM` for delegated repair, ADR 0115 §3, mandated by
  [Step R0](#step-r0--a-repair-dispatch-must-carry-a-claim-token-no-token--refuse-never-a-judgment-call))
  before the R2 branch switch and the R3 push/comment, so a mis-dispatched repair never clobbers
  another agent's live PR (the #1404 class). Fail-closed: an absent or foreign claim refuses, and
  the refusal is **not overridable by a corroborated dispatch brief** (#3751).
- **Idempotent.** Re-running on an already-fixed / PASS PR (one with no latest FAIL, or one
  whose latest FAIL is bound to a now-stale head) is a clean no-op (Step R1).
- **SHA-bound verdicts (ADR [0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md)).**
  Act only on a FAIL bound to the PR's **current head** — a FAIL whose `@ <sha>` is stale (or
  absent) judges code that has since changed, so repair mode ignores it. This mirrors
  `ship-it` Step 2b's staleness refusal on the reading side.
- **All three namespaces.** Handle `review-code: FAIL @ <sha>`, `review-doc: FAIL @ <sha>`
  **and** `review-skill: FAIL @ <sha>` ([the gate-verdict contract
  §VERDICT](../shared/gate-verdict-contract.md)) — latest current-head verdict per namespace —
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
