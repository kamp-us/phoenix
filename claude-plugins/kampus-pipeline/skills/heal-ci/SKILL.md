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
Run/check reads go through `gh run`; issue writes go through `gh api` REST (or, better,
the `report` skill). This is not a style preference — GraphQL errors out on this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

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

You're given a run id, or a PR (resolve its latest run). Pin the identifiers you'll reuse
once, up front, then use the vars in every command below:

```bash
RUN=<run id>     # the failed run
PR=<n>           # the PR, if this is a PR run (else leave unset)
gh run view $RUN --log-failed
# the job/step rollup, to know which job died (and its databaseId, for the fallback below)
gh run view $RUN --json conclusion,headBranch,jobs \
  --jq '{conclusion, headBranch, jobs: [.jobs[] | select(.conclusion=="failure") | {name, databaseId, steps: [.steps[] | select(.conclusion=="failure") | .name]}]}'
```

If `--log-failed` returns nothing (it sometimes does — e.g. a bare `exit 1` with no
annotated failed-step rows), fall back to the failed job's full log: take its `databaseId`
from the rollup above and read the job log directly via the REST API, then grep/scope to the
failed step's output. You must **always** be able to reach the actual log body to match the
taxonomy — never stay stuck with only step names.

```bash
JOB=<failed job databaseId from the rollup above>
gh api repos/$REPO/actions/jobs/$JOB/logs
```

If you only have a PR: `gh pr checks $PR` → the red check's run id (set `RUN`), then the above.

**Then detect whether this run was already rerun** — this is the stateless guard that makes
the one-rerun rule hold across invocations (this skill is per-invocation memoryless; nothing
but the run/PR state itself remembers a prior rerun). Read two facts:

```bash
# 1) the run's own attempt count: a rerun bumps `attempt` to 2+
ATTEMPT=$(gh run view $RUN --json attempt --jq '.attempt')
# 2) a prior heal-ci rerun marker on the PR (if this is a PR run)
gh api repos/$REPO/issues/$PR/comments --jq \
  '[.[] | select(.body | test("heal-ci:.*rerun queued"))] | length'
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
gh run rerun $RUN --failed
# on a PR run, write the marker Step 1's already-rerun detector queries:
gh api repos/$REPO/issues/$PR/comments \
  -f body="heal-ci: <signature> — rerun queued (run $RUN). One rerun only; a recurring failure becomes a defect."
```

This marker string and Step 1's `test("heal-ci:.*rerun queued")` grep are a paired contract — change the phrasing here and you must update the matcher there (same discipline ship-it uses for its `review-code:` / `review-doc:` anchors).

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

- **The native `CHANGES_REQUESTED` review that folds into the code namespace.** The verb reads
  marker comments; a native review is a *different* record type. GitHub author-attributes reviews,
  so this path needs **no** ACL gate — `commit_id` IS its bound SHA, and a decisive review whose
  `commit_id` prefix-matches the current head is a code FAIL exactly as a marker one is.
- **The N=3 FAIL-round count.** `verdict read` resolves the latest verdict; it does not count
  rounds. A PR already at 3 FAIL rounds is escalated to a human, **not** an active repair, so the
  guard counts the rounds itself (author-gated to write+ collaborators, clustered by >120s gap —
  the same round identity write-code uses) and treats a capped PR as fall-through-and-file.

```bash
# is a write-code repair already in flight on this PR? (PR runs only) — resolve the verdict the
# EXACT way write-code Step R1 does, by delegating each (PR, gate) FAIL-bound-to-head resolution to
# `pipeline-cli verdict read` (ACL author-gate + latest-wins + SHA-staleness, ADR 0055/0058). Resolve
# the CLI once — in-repo-first, published-fallback (ADR 0062/0064; epic #994).
if [ -f packages/pipeline-cli/src/bin.ts ]; then
  VERDICT="node packages/pipeline-cli/src/bin.ts verdict"   # phoenix-local: the in-repo consolidated bin
else
  VERDICT="pnpm dlx @kampus/pipeline-cli@0.2.0 verdict"     # foreign install: the published CLI
fi

# a namespace is an active-repair FAIL iff its latest authorized verdict is FAIL bound to the current
# head — exit 0 from `verdict read … --expect FAIL`. A stale / SHA-less / PASS / none verdict exits
# non-zero, so it is correctly NOT an active repair, matching write-code's no-op on it.
$VERDICT read --pr "$PR" --gate code --expect FAIL >/dev/null 2>&1 && CODE_FAIL=1 || CODE_FAIL=0
$VERDICT read --pr "$PR" --gate doc  --expect FAIL >/dev/null 2>&1 && DOC_FAIL=1  || DOC_FAIL=0

# the native CHANGES_REQUESTED review folds into the code namespace (the verb reads only marker
# comments): a decisive review whose commit_id prefix-matches the current head is a code FAIL too.
CURRENT_HEAD="$(gh api repos/$REPO/pulls/$PR --jq .head.sha)"
REVIEW=$(gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  --jq '[.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
        | sort_by(.submitted_at) | last | {state, sha: .commit_id}')
RSTATE=$(jq -r '.state // ""' <<<"$REVIEW"); RSHA=$(jq -r '.sha // empty' <<<"$REVIEW")
[ -n "$RSHA" ] && [ "$RSTATE" = "CHANGES_REQUESTED" ] && case "$CURRENT_HEAD" in "$RSHA"*) CODE_FAIL=1 ;; esac

# the N=3 repair cap `verdict read` does NOT count: a PR already at 3 FAIL rounds is escalated to a
# human, NOT an active repair. Author-gate the FAIL markers to write+ collaborators (ADR 0055) and
# cluster by >120s gap — the same round identity write-code uses.
comments_file=$(mktemp)
gh api "repos/$REPO/issues/$PR/comments?per_page=100" > "$comments_file"
markerAuthors=$(jq -r '[.[]
    | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*(PASS|FAIL)"; "i"))
    | .user.login] | unique | .[]' "$comments_file")
authorized='[]'
while IFS= read -r a; do
  [ -z "$a" ] && continue
  perm=$(gh api "repos/$REPO/collaborators/$a/permission" --jq .permission 2>/dev/null)
  case "$perm" in
    admin|maintain|write) authorized=$(jq -c --arg a "$a" '. + [$a]' <<<"$authorized") ;;
  esac
done <<<"$markerAuthors"
ROUNDS=$(jq --argjson authorized "$authorized" \
  '[.[] | select(.user.login | IN($authorized[]))
        | select(.body | test("^\\s*\\**\\s*review-(code|doc):\\s*FAIL"; "i"))
        | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
   | sort
   | reduce .[] as $t ({n:0, prev:null};
       if (.prev == null) or ($t - .prev) > 120
       then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
   | .n' "$comments_file")
```

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
gh api repos/$REPO/issues/$PR/comments \
  -f body="heal-ci: CI red — <signature>. Active write-code repair in flight (latest gate verdict FAIL); not filing a twin. Run <run url> — fold into the in-flight fix."
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
gh api repos/$REPO/issues/$PR/comments \
  -f body="heal-ci: CI red — <signature>. Filed #$N (needs-triage). Not merged."
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
