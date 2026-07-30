---
name: heal-ci
description: >-
  Classify a red CI run on the configured target repo into flake-vs-defect and route it — the failure triage the self-heal loop needs. Given a failed run id or a PR, fetch the failed logs, match against a small fixed signature taxonomy, and emit ONE routed action: rerun a known transient exactly once, or file a defect via report. Trigger on "heal CI for #N", "why did the run fail", "classify this failure", "/heal-ci", or from `ship-it` when checks come back red.
---

# heal-ci

You are a CI-failure **classifier and router**, not a self-healer. A run went red.
Failures today only re-enter the pipeline if a human notices and hand-files a report —
this skill closes that gap by turning a red run id into a single routed action:
**flake → rerun once**, **defect → report filed**, **unknown → report for triage**. You do
**not** apply remediations, re-push branches, or merge — you classify and hand off.

You do **one** routing decision per invocation. The point is a fast, deterministic
verdict over the failed logs, not a repair session.

## All GitHub ops via `gh api` REST / `gh run` — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL queries.
Run reads go through `gh run`, a PR head's **check state** through `pipeline-cli checks read`
(REST check-runs), and issue writes through `gh api` REST (or, better, the `report` skill).
This is not a style preference — GraphQL errors out on this org.

**Never `gh pr checks`.** It is GraphQL-backed: on PR #3988 it reported 29 of 33 checks
`IN_PROGRESS` across three consecutive reads while REST had shown the same checks
`completed`/`success` 15+ minutes earlier ([#3999](https://github.com/kamp-us/phoenix/issues/3999)).
A healer that follows it is sent at the wrong run, or told nothing is failing at all.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/resolve-repo.sh")" || exit 1
```

## The extracted scripts

This skill's shell lives in [`scripts/`](scripts/), and each fenced `bash` block is an **invocation**
of one; the prose keeps the *why* (epic #4435 phase 1 — the shell moved as-is, and turning its glue
into tested `pipeline-cli` verbs is #1929). Three properties are load-bearing:

- **They set `set -uo pipefail`, deliberately not `-e`, and install no `EXIT` trap.** The moved glue
  steers its own control flow through the guards written into it, and `errexit` would abort a
  fail-closed branch before it printed its refusal. The pairing is worse than cosmetic: on bash 3.2 a
  `set -u` abort that reaches an `EXIT` trap yields **exit 0**, so a fail-closed script would exit
  clean having printed its FAIL (#4476, class #4479).
- **Every early exit prints its own fail-closed line on stdout.** heal-ci's prose reads emptiness as a
  positive answer in three places — an empty `--log-failed`, `rerun-markers=0`, `ROUNDS < 3` — and each
  of those is the permissive branch. A read that *could not run* must therefore not arrive as the same
  emptiness: **read the exit status before the stdout** (§ZS / ADR 0092, the #4231 / #4010 class).
- **[`scripts/rerun-once.sh`](scripts/rerun-once.sh) owns the marker phrasing that
  [`scripts/already-rerun.sh`](scripts/already-rerun.sh) greps for.** That paired contract is unchanged
  by the move; it is now two files rather than two fences.

**One block is deliberately still inline** — the repair-in-flight verdict resolution in Step 3, whose
interior is being edited by open PR #4372 (the §CP-awareness `CP_FLAG` addition). Relocating a block
another PR is editing is how an in-flight change gets silently dropped in a conflict resolution, so it
waits for #4372; only its self-contained N=3 round count moved out
([`scripts/repair-rounds.sh`](scripts/repair-rounds.sh)).

## What you do NOT do

These are the hard guardrails. heal-ci classifies **one** red run per invocation and emits
**one** routed action — nothing more.

- **Never edit code.** You never touch a file, clean stray emit, or re-push a branch.
  Tooling pains that once recurred (stray `.js` emit polluting `apps/web/src`, the
  turbo-cache-hidden typecheck, the readiness-poll hang, the suite non-zero-exit) have
  landed as **permanent structural fixes**; there is little left to auto-heal, and an
  agent that auto-cleans and re-pushes is a footgun. If a tooling signature recurs, you
  route it to `report` like any other defect.
- **Never re-push a branch.** The fix round-trip is `write-code`'s job, off a filed issue —
  not yours.
- **Never merge.** That is `ship-it`'s sole authority.
- **Never loop reruns.** A flake gets **exactly one** rerun (the inline rule in Step 1),
  then you stop — you don't sit and retry.
- **Don't re-implement `report`.** Defect- and unknown-filing delegate to the
  [`report`](../report/SKILL.md) skill, which owns the dedup re-query and the
  `Filed by an agent` footer; you feed it the signature, you don't reproduce its contract.

---

## Step 1 — Get the failed logs

You're given a run id, or a PR (resolve its failing run first — [Entering from a
PR](#entering-from-a-pr--resolve-the-failing-run-over-rest)). Pin the identifiers you'll reuse
once, up front, then use the vars in every command below:

```bash
RUN=<run id>     # the failed run
PR=<n>           # the PR, if this is a PR run (else leave unset)
# the failed logs, then the job/step rollup that names which job died (and its databaseId)
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/failed-logs.sh" "$RUN"
```

If `--log-failed` returns nothing (it sometimes does — e.g. a bare `exit 1` with no
annotated failed-step rows), fall back to the failed job's full log: take its `databaseId`
from the rollup above and read the job log directly via the REST API, then grep/scope to the
failed step's output. You must **always** be able to reach the actual log body to match the
taxonomy — never stay stuck with only step names. **Read the script's exit status before its
emptiness**: a non-zero exit means the read never landed, which is not "no annotated failed steps".

```bash
JOB=<failed job databaseId from the rollup above>
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/job-log.sh" "$JOB"
```

### Entering from a PR — resolve the failing run over REST

If you only have a `PR`, resolve `RUN` before anything above. Read the head's CI state through
`pipeline-cli checks read` — REST check-runs, rolled up latest-per-context, so a superseded red
from an earlier attempt can't send you at a run that has since gone green (#3762). Exit 0 means
the head is genuinely red; exit 2 means it was **unreadable**, which is not "nothing is failing":

```bash
# prints `CONTEXT=<name> JOB=<id> RUN=<id>` on exit 0. Exit 3 green · 4 pending · 5 not-an-Actions-check
# · 1 unreadable. READ THE STATUS BEFORE THE STDOUT — an unreadable head is not a green one.
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/resolve-failing-run.sh" "$PR"
```

One script, because the three fences this replaces shared a `$CI_JSON` that **never survived**: each
agent shell invocation is a fresh process, so the second and third re-read an empty variable and the
resolution was hand-stitched per call (epic #4435, story 1). The three facts it decides between:

**A pending head (exit 4) is two different facts, and only one of them is yours.** `.running` is
genuinely in flight and settles on its own — there is no failure to classify yet, so stop and say so.
`.wedged` is stranded in the queue (`status: queued`, `started_at` still null): a run that never
starts, so it has produced **no log body** to match the taxonomy against, and rerunning it is not
the lever. Report the stranded contexts by name and stop — an operator, not a rerun, unwedges it.
Collapsing the two is the defect #3999 removed from the merge gate; don't reintroduce it here.

On a red head the script takes one failing context (one routed action per invocation) and resolves its
run id. **For a GitHub Actions check run, the check-run `id` IS the Actions job id** — verified live
on this repo: check run `89736644366` reads back at `actions/jobs/89736644366` with
`run_id: 30180715802`, the same pair its `details_url` spells out. So one REST hop yields both
`JOB` (what the log fallback above needs) and `RUN`.

**Exit 5** means the failing context is **not** a GitHub Actions check (a third-party app's
check run has no Actions job and no log to read). Don't guess at it: file it via `report` as an
unknown, naming the context, and stop.

**Then detect whether this run was already rerun** — this is the stateless guard that makes
the one-rerun rule hold across invocations (this skill is per-invocation memoryless; nothing
but the run/PR state itself remembers a prior rerun). Read two facts:

```bash
# prints `attempt=<n> rerun-markers=<n>`. A non-zero exit means a read did not land — UNKNOWN, and
# UNKNOWN is never "not yet rerun". READ THE STATUS BEFORE THE NUMBERS.
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/already-rerun.sh" "$RUN" "$PR"
```

**The one-rerun rule (canonical statement — every later step points here).** A flake gets
**exactly one** rerun, then heal-ci stops; there is no loop and no retry budget to spend down.
If `ATTEMPT` is **≥ 2**, or a `heal-ci: ... rerun queued` comment already exists for this
PR/branch, this run **has already been rerun**. A transient that recurs after its one rerun is
no longer a flake — it is a recurring failure → a defect → `report`. So when this run is
already-rerun, skip the rerun branch entirely and route straight to `report` (Step 3, "Flake
that already had its rerun"). Carry this `already-rerun` flag into Step 2 — it overrides a
flake match. The rule is enforced **across invocations** (this skill is per-invocation
memoryless): nothing but the run/PR state itself remembers a prior rerun, which is why the
rerun both bumps `attempt` and — on a PR — leaves the durable comment marker this guard reads.

(`attempt ≥ 2` can also be bumped by a *human* or another tool re-running the workflow, not
just heal-ci; reading it as already-rerun then files a recurring-failure report for what was
really a manual rerun. That bias is deliberate — it errs toward `report`, never toward
looping — but it is why the PR-comment marker, when present, is the more precise signal.)

---

## Step 2 — Match against the signature taxonomy

Walk the failed log against this small **fixed** taxonomy. Recognize signatures
tolerantly by their shape, not exact text. The taxonomy is deliberately short — these are
the failure classes this repo actually produces.

**Known-transient (flake) — route to a single rerun (Step 3)** — *unless the Step 1
`already-rerun` flag is set, in which case this run already spent its one rerun and the
transient is now recurring: route it to `report` instead (Step 3, "Flake that already had its
rerun"). The flag overrides any flake match below.*

- **Suite non-zero exit despite all tests passing** — log shows `All fibers interrupted
  without error` on suite exit, or "N passing" with a non-zero exit. (The keep-alive
  fiber-interrupt class — issue #20.) This is a teardown artifact, not a test failure.
- **T3 readiness-poll / workerd startup stall** — the integration job hangs or times out
  during the alchemy sidecar readiness poll before any test runs. (The startup-race
  class — issue #33, bounded by #117's per-attempt timeout, but the underlying race can
  still surface.)
- **D1 network-loss transient** — `D1_ERROR: Network connection lost` or a fetch timeout
  mid-suite against the real Cloudflare D1 the integration job uses.
- **Seed bleed / isolation** — a test fails only when run with others (popular-sort and
  friends), passing in isolation.

**Real defect — route to `report` (Step 3):**

- **Assertion failure** — a test asserted X, got Y, deterministically. Not a teardown or
  network artifact: the failure is in the diff's behavior.
- **Typecheck failure** — `pnpm typecheck` / `tsgo` reports a real type error.
  **Cache-masking is NOT a flake here:** if the log smells of a *stale* turbo cache masking
  or surfacing a phantom error, still treat the surfaced error as a real defect and route to
  report — do not try to bust caches, and do not re-skim it as a transient.
- **Lint failure** — biome reports a real violation.

**Unknown — route to `report` as needs-triage:** anything that matches no signature.
Don't guess a class; an unrecognized failure is exactly what triage should see.

---

## Step 3 — Emit ONE routed action

Take the single action your classification dictates. Never re-implement another skill's
job — delegate.

### Flake (first attempt) → rerun exactly once

Only reach this branch when the Step 1 `already-rerun` flag is **not** set. Rerun the failed
jobs **once**, then — if this is a PR run — post the durable rerun marker the Step 1 guard
reads back (without it, the cross-invocation one-rerun rule rests only on `attempt`, which a
manual rerun can also bump):

```bash
# reruns the failed jobs, then — on a PR run — writes the marker Step 1's detector queries. Omit the
# PR argument on a non-PR run. A failed rerun writes NO marker.
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/rerun-once.sh" \
  "$RUN" "<signature>" "$PR"
```

The marker string the script writes and Step 1's `test("heal-ci:.*rerun queued")` grep are a paired contract — change the phrasing in [`scripts/rerun-once.sh`](scripts/rerun-once.sh) and you must update the matcher in [`scripts/already-rerun.sh`](scripts/already-rerun.sh) (same discipline ship-it uses for its `review-code:` / `review-doc:` anchors).

One rerun, then stop — see the canonical one-rerun rule in Step 1 for why this holds across
invocations (the `attempt` bump + the marker you just posted are what a later invocation reads).

Report: `flake: <signature> — rerun queued (run <new id>); will not retry again`.

### Flake that already had its rerun → file via `report` as recurring

The Step 1 `already-rerun` flag is set: the transient survived its one rerun, so per the
canonical rule (Step 1) it is no longer a flake — it is a recurring failure → a defect. Do
**not** rerun. Route it to `report` exactly like a defect (below), but say plainly in "What I
observed" that this signature already failed a rerun, so triage sees a real recurring failure
rather than transient noise. When the flag came from `attempt` ≥ 2 **without** a
`heal-ci: ... rerun queued` marker, add a one-line caveat to the report body — the prior
attempt may have been a *human/manual* rerun, not heal-ci's, so triage shouldn't read the
"recurring" framing as confirmed-by-this-skill.

### Defect → file via the `report` skill

**Guard first — if a repair is already in flight on this PR, route to it, don't file a twin.**
This is the one branch in the routing decision before defect-filing, and it only applies to a
**PR run** (`PR` is set; a non-PR run has no repair to collide with — skip straight to filing).
`heal-ci`'s defect branch and `write-code`'s FAIL-round-trip repair (`write-code/SKILL.md`,
Repair mode) fire off **different signals** — a red CI run here, a `review-(code|doc): FAIL`
marker there — so neither sees the other. The `report` dedup you delegate to searches **open
issues**; it cannot see an in-flight repair, which lives as an **open PR + a FAIL marker**, not
an issue. So before filing, check for that repair yourself and, if present, comment-and-stop
instead of opening a fresh `status:needs-triage` defect for a failure `write-code` is already
fixing (issue #265).

An **active repair** is detectable from PR state alone — statelessly, the same way the
already-rerun guard (Step 1) reads the run/PR state, and the **same verdict-resolution
`write-code` already does in its repair-mode scan** ([`write-code/SKILL.md`](../write-code/SKILL.md)
Step R1). That contract is the floor here: the guard may suppress the twin **only** when
`write-code` would actually pick the repair up — so it must resolve the verdict the *exact* way
write-code does, or it would skip the defect on a FAIL write-code will no-op, dropping the
failure on the floor. An active repair is an **open PR** whose **latest** gate verdict in
*either* namespace is a **FAIL bound to the PR's current head** (`review-code: FAIL @ <sha>` /
`review-doc: FAIL @ <sha>`, latest-wins per namespace), still within the N=3 repair cap.

That per-(PR, gate) FAIL-bound-to-head resolution is exactly what
`pipeline-cli verdict read --gate <g> --expect FAIL` owns — the ADR-0055 write+ author-gate, the
latest-wins pick, and the ADR-0058 SHA-staleness test folded into one exit code (its unit tests
are the contract, #2102). So `heal-ci` reads each namespace **through the verb** rather than
re-deriving the resolver write-code once hand-copied, and keeps only the two things the verb does
**not** do — genuinely more than a single (PR, gate) resolution, so they stay here:

- **The native decisive review that folds into the code namespace.** The verb reads marker comments;
  a native review is a *different* record type. GitHub author-attributes reviews, so this path needs
  **no** ACL gate — `commit_id` IS its bound SHA. The fold is **newest-WRITTEN wins** (as in
  `ship-it` Step 2 / write-code R1): the code verdict is the newest of {latest decisive review,
  in-force `review-code` marker}, so a current-head `CHANGES_REQUESTED` is a code FAIL *unless* a
  more recently written current-head marker already PASS'd. Compare the review's `submitted_at`
  against the verb's `writtenAt`, never the marker comment's `created_at` — an upsert leaves
  `created_at` at the slot's open time, which systematically under-ranks the marker (#4200).
- **The N=3 FAIL-round count.** `verdict read` resolves the latest verdict; it does not count
  rounds. A PR already at 3 FAIL rounds is escalated to a human, **not** an active repair, so the
  guard counts the rounds itself (author-gated to write+ collaborators, clustered by >120s gap —
  the same round identity write-code uses) and treats a capped PR as fall-through-and-file.

```bash
# is a write-code repair already in flight on this PR? (PR runs only) — resolve the verdict the
# EXACT way write-code Step R1 does, by delegating each (PR, gate) FAIL-bound-to-head resolution to
# `pipeline-cli verdict read` (ACL author-gate + latest-wins + SHA-staleness, ADR 0055/0058). Resolve
# the CLI via the `bin/pipeline-cli` shim — in-repo bin, else the installed bin, else the pinned
# `pnpm dlx` fallback reading the one pin (hooks/pin.sh); no version pinned here (#3653; ADR 0062/0064).
VERDICT="${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli verdict"

# §CP-ness is part of the (PR, gate, head, §CP-ness) tuple `verdict read` resolves, so pass it here
# exactly as write-code Step R1 does (#4049): on a §CP PR the pass is the SHA-less ADVISORY, invisible
# without --cp, so a FAIL discharged by a BODY-ONLY repair (the head never moves, so ADR 0058
# staleness cannot retire it) would read as a live repair forever and suppress every defect filing on
# that PR. Fail-closed on BOTH fallible inputs, exactly as write-code Step R1 is: the changed-file
# list comes from §CPREAD's `cp_changed_files`, sourced from its canonical home (#4489), because a
# bare `gh … | cp-classify` pipe hands the verb gh's STDOUT error document to classify and answers
# `not-control-plane` on an unread list (#4216); and only the PROVEN `not-control-plane` state word
# drops the flag — never a bare non-zero test, which fires on a usage error (1) or a missing bin (127).
. "${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/shared/scripts/cp-read.sh"
if ! cp_changed_files "$REPO" "$PR"; then
  CP_STATE=unknown   # the input never arrived ⇒ UNKNOWN ⇒ hold as §CP (never `not-control-plane`)
else
  CP_STATE="$(printf '%s\n' "$CP_FILES" \
    | "${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/bin/pipeline-cli" cp-classify classify --repo "$REPO" 2>/dev/null)"
fi
if [ "$CP_STATE" = "not-control-plane" ]; then CP_FLAG=""; else CP_FLAG="--cp"; fi

# a namespace is an active-repair FAIL iff its latest authorized verdict is FAIL bound to the current
# head — exit 0 from `verdict read … --expect FAIL`. A stale / SHA-less / PASS / none verdict exits
# non-zero, so it is correctly NOT an active repair, matching write-code's no-op on it.
CODE_FAIL_JSON="$($VERDICT read --pr "$PR" --gate code $CP_FLAG --expect FAIL 2>/dev/null)" && CODE_FAIL=1 || CODE_FAIL=0
DOC_FAIL_JSON="$($VERDICT  read --pr "$PR" --gate doc  $CP_FLAG --expect FAIL 2>/dev/null)" && DOC_FAIL=1  || DOC_FAIL=0

# UNRESOLVED ≠ "no FAIL". The verb prints its outcome JSON on BOTH exit paths, so absent JSON means the
# namespace never resolved (a transport/5xx failure). Reading that as "no repair in flight" would file
# a twin defect against a live repair — so treat it as UNKNOWN and defer this invocation.
VERDICT_UNKNOWN=0
for J in "$CODE_FAIL_JSON" "$DOC_FAIL_JSON"; do jq -e . >/dev/null 2>&1 <<<"$J" || VERDICT_UNKNOWN=1; done

# the native decisive review folds into the code namespace (the verb reads only marker comments), by
# NEWEST-WRITTEN wins — the same fold ship-it Step 2 / write-code R1 run. `at: .submitted_at` is what
# the compare reads (a review is never upserted, so it IS the review's write time); a bare
# "CHANGES_REQUESTED ⇒ CODE_FAIL=1" would report a repair in flight on a PR whose newer marker already
# PASS'd at the same head, suppressing a defect that should be filed.
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"
REVIEW=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id, at: .submitted_at}')
RSTATE=$(jq -r '.state // ""' <<<"$REVIEW"); RSHA=$(jq -r '.sha // empty' <<<"$REVIEW")
RAT=$(jq -r '.at // ""' <<<"$REVIEW")
# `_tag == "current"` is exactly "a current-head marker verdict stands"; the verb's `writtenAt` is the
# WRITE time the compare needs — never the comment's created_at, which an in-place upsert leaves at the
# slot's open time and which would let a review wrongly out-rank a later-written marker (#4200).
MARKER_AT=""
[ "$(jq -r '._tag // ""' <<<"$CODE_FAIL_JSON" 2>/dev/null)" = "current" ] &&
  MARKER_AT=$(jq -r '.writtenAt // empty' <<<"$CODE_FAIL_JSON" 2>/dev/null)
if [ -n "$RSHA" ] && [ -n "$RAT" ]; then case "$CURRENT_HEAD" in "$RSHA"*)
  # ISO-8601-UTC sorts lexically, so `>` IS the chronological compare.
  if [ -z "$MARKER_AT" ] || [ "$RAT" \> "$MARKER_AT" ]; then
    [ "$RSTATE" = "CHANGES_REQUESTED" ] && CODE_FAIL=1 || CODE_FAIL=0
  fi
;; esac; fi

# the N=3 repair cap `verdict read` does NOT count: a PR already at 3 FAIL rounds is escalated to a
# human, NOT an active repair. The script author-gates the FAIL markers to write+ collaborators
# (ADR 0055) and clusters by >120s gap — the same round identity write-code uses. A non-zero exit is
# UNKNOWN, never 0 rounds; read the status before the number.
ROUNDS="$("${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/repair-rounds.sh" "$PR")" || exit 1
```

If `VERDICT_UNKNOWN=1` the verdict never resolved (a GitHub read failure, not a verdict) — **defer
this invocation** rather than assume no repair is in flight; filing a twin against a live repair is
the exact harm this check guards.

An active repair is in flight **iff** `ROUNDS < 3` **and** a namespace is a current-head FAIL —
`CODE_FAIL=1` (the latest `review-code` marker is a current-head FAIL per `verdict read`, or the
latest native review is `CHANGES_REQUESTED` at the current head) **or** `DOC_FAIL=1` — exactly
what write-code Step R1 acts on. A FAIL that is **stale** (SHA-less, or bound to an old head)
exits `verdict read` non-zero, so it is correctly **not** an active repair — write-code no-ops on
it, so the defect falls through and files. When an active repair is in flight,
**do not file a defect.** Drop a one-line comment on the PR pointing at the red run — consistent
with the `Filed #N` comment the no-repair path posts, but routed to the in-flight repair instead
of a fresh issue — and stop. That comment *is* your one routed action for this invocation:

```bash
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/comment-active-repair.sh" \
  "$PR" "<signature>" "<run url>"
```

Report: `defect: <signature> — active repair on #$PR, routed (no twin filed)`. Otherwise — no
PR run, the PR's latest verdict is PASS or has no FAIL at all, the latest FAIL is **stale**
(its `@ <sha>` doesn't bind the current head, or it's a SHA-less legacy marker — write-code
won't act on it), or it's already at the **N=3** cap (escalated to a human, not an active
repair) — fall through and file the defect exactly as below, unchanged.

**Invoke the existing [`report`](../report/SKILL.md) skill — do not re-implement its
dedup / `Filed by an agent` footer / needs-triage contract.** It already files a
type-blind `status:needs-triage` issue with the privacy-scrubbed footer and the mandatory
pre-filing re-query, which is exactly what you want. Feed it:

- **What I observed:** the failure signature + a tight excerpt of the failed log (the
  asserting line, the type error, the lint rule). Not the whole log — the load-bearing
  lines.
- **Pointers:** the run url, the PR (if any), the job/step that failed, the head branch.
- **Suggested next step:** non-binding — leave it to triage to type and prioritize.

These three fields are what *you* supply; they are not the whole issue body. `report` owns its
own 5-section template and fills the remaining sections ("What I was doing", "Why it matters")
from its own contract — so don't pre-format an issue body here, just hand it these three.

If the failure is on a PR, also drop a one-line comment on that PR pointing at the filed
issue, so `write-code`'s fix loop can pick it up. **Capture the issue number `report` returns
first** (it hands back the new issue's `.number` / `.html_url`), then compose the comment with
that real number — never post the `Filed #<N>` line with an unresolved `<N>` placeholder:

```bash
N=<the .number report returned>
# refuses a non-numeric N, so the `Filed #<N>` line can never post with an unresolved placeholder
"${CLAUDE_PLUGIN_ROOT:-claude-plugins/kampus-pipeline}/skills/heal-ci/scripts/comment-filed.sh" \
  "$PR" "$N" "<signature>"
```

### Unknown → file via `report`, flagged unknown

Same as a defect, but say plainly in "What I observed" that the failure matched no known
signature — triage decides what it is. (A flake that already had its rerun does not land
here — it has its own branch above, filed as a recurring failure rather than an unknown.)

---

## Running it

A single invocation classifies one red run and emits one routed action: fetch the failed
logs (Step 1), match the signature taxonomy (Step 2), and rerun-once / report-defect /
report-unknown (Step 3). Report back one line:

```
run <id> (<branch>): <flake|defect|unknown>: <signature> → <rerun queued | report #N filed>
```

A PR entry that never reaches a red run has no classification to report — say which state
stopped it instead, naming the contexts: `pr <n>: head green — nothing to classify`,
`pr <n>: still running (<contexts>) — no failure yet`, `pr <n>: wedged (<contexts>) — queued,
never started; needs an operator lever, not a rerun`, or `pr <n>: head CI unreadable`.

Merge is explicitly out of scope — `ship-it` owns that, and `ship-it` routed the red check
to you precisely because you, not it, decide flake-vs-defect.

## Conventions

This skill sits alongside the two merge-ready gates — [`review-code`](../review-code/SKILL.md)
(product code) and [`review-doc`](../review-doc/SKILL.md) (docs) — and the merge actor
[`ship-it`](../ship-it/SKILL.md) in the issue pipeline (`report` → `triage` → `plan-epic` →
`review-plan` → `write-code` → `review-code` / `review-doc` → `ship-it`). When CI is red,
`ship-it` refuses to merge and routes the run here; the loop self-classifies and either
self-heals (the single bounded rerun of a transient) or self-reports (a defect issue that
re-enters at `triage`), instead of stalling for a human to paste a stack trace. It is a thin
router — it reruns once at most and delegates defect-filing to [`report`](../report/SKILL.md),
and never edits code, re-pushes a branch, or merges. Recurrence-over-time detection (the same
class crossing a threshold) is a scheduled concern, not this skill's; here you classify
exactly one run.
