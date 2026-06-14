---
name: heal-ci
description: Classify a red CI run on kamp-us/phoenix into flake-vs-defect and route it — the failure triage the self-heal loop needs. Given a failed run id or a PR, fetch the failed logs, match against a small fixed signature taxonomy, and emit ONE routed action: rerun a known transient exactly once, or file a defect via report. Trigger on "heal CI for #N", "why did the run fail", "classify this failure", "/heal-ci", or from `ship-it` when checks come back red. It never merges and never auto-edits code.
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
- **Never loop reruns.** A flake gets **exactly one** rerun (the inline rule in Step 3),
  then you stop — you don't sit and retry.
- **Don't re-implement `report`.** Defect- and unknown-filing delegate to the
  [`report`](../report/SKILL.md) skill, which owns the dedup re-query and the
  `Filed by an agent` footer; you feed it the signature, you don't reproduce its contract.

---

## Step 1 — Get the failed logs

You're given a run id, or a PR (resolve its latest run). Fetch only what failed:

```bash
RUN=<run id>
gh run view $RUN --log-failed
# the job/step rollup, to know which job died
gh run view $RUN --json conclusion,headBranch,jobs \
  --jq '{conclusion, headBranch, jobs: [.jobs[] | select(.conclusion=="failure") | {name, steps: [.steps[] | select(.conclusion=="failure") | .name]}]}'
```

If you only have a PR: `gh pr checks <PR>` → the red check's run id, then the above.

**Then detect whether this run was already rerun** — this is the stateless guard that makes
the one-rerun rule hold across invocations (this skill is per-invocation memoryless; nothing
but the run/PR state itself remembers a prior rerun). Read two facts:

```bash
# 1) the run's own attempt count: a rerun bumps `attempt` to 2+
ATTEMPT=$(gh run view $RUN --json attempt --jq '.attempt')
# 2) a prior heal-ci rerun marker on the PR (if this is a PR run)
gh api repos/kamp-us/phoenix/issues/<PR>/comments --jq \
  '[.[] | select(.body | test("heal-ci:.*rerun queued"))] | length'
```

If `ATTEMPT` is **≥ 2**, or a `heal-ci: ... rerun queued` comment already exists for this
PR/branch, this run **has already been rerun**. A transient that recurs after a rerun is no
longer a flake: skip the rerun branch entirely and route straight to `report` as a recurring
failure (Step 3, "Flake that already had its rerun"). Carry this `already-rerun` flag into
Step 2 — it overrides a flake match.

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
gh api repos/kamp-us/phoenix/issues/<PR>/comments \
  -f body="heal-ci: <signature> — rerun queued (run $RUN). One rerun only; a recurring failure becomes a defect."
```

**The one-rerun rule, inline and concrete:** you rerun **exactly once**. There is no loop
and no retry budget to spend down — one rerun, then stop. The rule is enforced **across
invocations** by the Step 1 detector: the rerun bumps the run's `attempt` to 2+, and (on a
PR) the `heal-ci: ... rerun queued` comment you post is the durable marker. A later
invocation against the recurring failure reads those, sees `already-rerun`, and takes the
next branch instead of rerunning again. One rerun, then it becomes a defect — that is the
whole policy, it lives here, not in any external doc.

Report: `flake: <signature> — rerun queued (run <new id>); will not retry again`.

### Flake that already had its rerun → file via `report` as recurring

The Step 1 `already-rerun` flag is set (run `attempt` ≥ 2, or a prior `heal-ci: ... rerun
queued` comment exists): the transient survived its one rerun and is now a recurring failure.
Do **not** rerun. Route it to `report` exactly like a defect (below), but say plainly in
"What I observed" that this signature already failed a rerun, so triage sees a real recurring
failure rather than transient noise. When the flag came from `attempt` ≥ 2 **without** a
`heal-ci: ... rerun queued` marker, add a one-line caveat to the report body — the prior
attempt may have been a *human/manual* rerun, not heal-ci's, so triage shouldn't read the
"recurring" framing as confirmed-by-this-skill.

### Defect → file via the `report` skill

**Invoke the existing [`report`](../report/SKILL.md) skill — do not re-implement its
dedup / `Filed by an agent` footer / needs-triage contract.** It already files a
type-blind `status:needs-triage` issue with the privacy-scrubbed footer and the mandatory
pre-filing re-query, which is exactly what you want. Feed it:

- **What I observed:** the failure signature + a tight excerpt of the failed log (the
  asserting line, the type error, the lint rule). Not the whole log — the load-bearing
  lines.
- **Pointers:** the run url, the PR (if any), the job/step that failed, the head branch.
- **Suggested next step:** non-binding — leave it to triage to type and prioritize.

If the failure is on a PR, also drop a one-line comment on that PR pointing at the filed
issue, so `write-code`'s fix loop can pick it up. **Capture the issue number `report` returns
first** (it hands back the new issue's `.number` / `.html_url`), then compose the comment with
that real number — never post the `Filed #<N>` line with an unresolved `<N>` placeholder:

```bash
N=<the .number report returned>
gh api repos/kamp-us/phoenix/issues/<PR>/comments \
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
