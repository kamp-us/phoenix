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
[Why the author may fix its own FAIL'd PR](repair.md#why-the-author-may-fix-its-own-faild-pr-this-is-not-a-firewall-violation)).
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

Each step below is a script under [`scripts/`](scripts), **executed by literal path** and read off
**stdout** — never sourced (ADR
[0232](https://github.com/kamp-us/phoenix/blob/main/.decisions/0232-agents-execute-skill-scripts-never-source-them.md)).
The harness's isolation verifier refuses `.` at an agent's top-level command by **any** path form, and
refuses the interpolated `"${CLAUDE_PLUGIN_ROOT:-…}"` idiom as too complex to verify; a plain literal
path is the one shape that runs ([#4595](https://github.com/kamp-us/phoenix/issues/4595)'s controlled
matrix). So every invocation looks like this, and the prose at each site names what to read off its
stdout:

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/<script>.sh <args>
```

**`.claude/.pipeline` is a symlink the hooks plant at the live plugin install, and the reason it
exists is portability, not tidiness ([#4605](https://github.com/kamp-us/phoenix/issues/4605)).** The
literal has to be true in *every* consuming repo, and `./claude-plugins/…` is true only inside a
phoenix checkout — a marketplace consumer's install lives in their plugin cache, outside their repo,
where that path is `No such file or directory`. A hook is a harness-*substituted* surface (it
receives `CLAUDE_PLUGIN_ROOT`), an agent's top-level command is not, so the hooks are the one place
that can know where the plugin actually is; the link is how they tell you. If it is missing, `bash`
exits **127 with nothing on stdout** — which is UNKNOWN, never "the script answered no" (§ZS below).

The handful of fences below that are *not* a script invocation — the milestone-drain read, the repair
escalation — call `gh api` directly, so they resolve the target repo in their own fence:

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

**Nothing crosses a Bash call in a shell variable.** The harness resets shell state between an
agent's Bash calls, so a value a step needs later travels one of three ways and never as an inherited
variable: printed on **stdout** (`WT=`, `BRANCH=`, `EPIC=`, `CONTAINMENT=`), passed as an explicit
**argument** to the next script, or written to the **§SP per-run scratch namespace**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §SP) — which is how repair mode's
author set, verdict payloads and FAIL body reach the steps that read them. The `$REPO` and `$PCLI`
each script needs are resolved **inside** it, through the shared lib's `kp_repo` / `kp_pcli`.

**A script's non-zero exit is UNKNOWN — never an answer (§ZS, ADR
[0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md)).**
Every script below prints its result on **stdout** and signals "I could not produce one" by a
**non-zero exit with no stdout**. Those two states are not the same, and the empty one is never
the permissive branch: an absent or empty result means the step did **not** run, so it can never be
read as "no parent", "no dependencies", "not a dark ship", or "no claim conflict". So every
invocation site whose **stdout is consumed as an answer** carries an explicit `|| exit 1`, and a
site that omits it is one whose script `exit`s on its own failure path. Never infer a negative from
silence.

Two things about those scripts, stated once here rather than repeated in thirty file headers:

- **The shape is [`.patterns/skill-script-shell-shape.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/skill-script-shell-shape.md)'s**
  — `set -uo pipefail`, never `-e`, no cleanup `EXIT` trap — and the stream contract is
  [`.patterns/skill-script-io-contract.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/skill-script-io-contract.md)'s:
  stdout is the answer, everything else is stderr. Each script declares the shellcheck codes *its own*
  lines raise in its `# shellcheck … disable=` directive (mostly `SC2086` on an unquoted `$REPO` in a
  `gh api` path) — declared per file, never blanket-suppressed, because quoting them would be the
  rewrite that is phase 2 ([#1929](https://github.com/kamp-us/phoenix/issues/1929)).
- **Two committed proofs re-derive the claims instead of asserting them**, both reviewer-runnable:
  [`scripts/verify-fail-closed.sh`](scripts/verify-fail-closed.sh) captures every seam's exit code
  **and** stdout byte count to prove no failure path can be read as an answer, and
  [`scripts/verify-executed-contract.sh`](scripts/verify-executed-contract.sh) asserts the shell
  shape, that no fence sources at the top level or interpolates `CLAUDE_PLUGIN_ROOT`, and that every
  literal path a fence invokes exists.

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

- **A PR number → repair mode. STOP READING THIS FILE HERE AND OPEN
  [`repair.md`](repair.md) NOW.** "Repair PR #N" / "fix the failed review on #N" hands you an
  *existing* PR, and every step a repair runs — R0/R1/R2/R3 — lives in that file, not below.
  It names the three sections of *this* file it depends on, so read it and follow its
  pointers back; do not read Steps 1–8 below, which are the initial build and do not apply.
  There you resolve the PR's latest gate verdict, and **only if** that latest verdict is
  FAIL, read the findings, fix them on the existing branch, push so the stateless gate
  re-runs, and stop. You do **not** pick new work, you do **not** branch, you do **not** merge.
- **An issue number, or no argument → initial-build mode.** "Implement #N" / "work the
  next issue" runs the normal **pick → claim → Steps 4–7** path below. This is unchanged.

The two are unambiguous: a PR number routes to repair, an issue number (or nothing) routes
to the pick-and-build path. If you're handed a bare number and genuinely can't tell which
it is, resolve it once — `gh api repos/$REPO/pulls/<N>` succeeds for a PR and
404s for a plain issue — and branch accordingly.

**The ownership boundary, stated once and load-bearing throughout:** **write-code owns
fail → fix → re-request; `ship-it` owns PASS → merge.** You own the branch and the PR, so
driving a FAIL'd PR back through the gate is your loop — but the merge is never yours, in
either mode (this mirrors the `gh-issue-intake-formats.md` relationship table, which
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
# Which of MY open PRs carry an unaddressed, current-head gate FAIL? An EMPTY answer means nothing of
# mine needs repair, so empty is the PERMISSIVE reading — a non-zero exit (127 = the CLI never ran) is
# UNKNOWN and must stop the run, never fall through to new work.
bash ./.claude/.pipeline/skills/write-code/scripts/step1-repairable-prs.sh || exit 1
```

If such a PR exists, **repair it instead of picking new work** — go to
[Repair mode](repair.md#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit) with that PR
number. Only once you have **no** PR with an unaddressed latest FAIL do you fall through to
the normal pick below. (This scan resolves each (PR, gate) verdict through the **same
authoritative SHA-bound `pipeline-cli verdict read`** repair mode Step R1 uses; R1 still
re-resolves at repair time because the head may move between this scan and the repair — a PR
that flipped to PASS, or whose FAIL went stale in that window, is then a clean no-op.)

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
# stdout IS the pool, one `#N<TAB>created_at<TAB>title` row per candidate, p0 rows first
bash ./.claude/.pipeline/skills/write-code/scripts/step1-candidate-pool.sh || exit 1
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
  milestone). The "active milestone" is resolved from a **single durable surface, not a
  per-run guess**: it is the arc pinned by the one `active` row of
  [`ROADMAP.md`](https://github.com/kamp-us/phoenix/blob/main/ROADMAP.md)'s `## Arcs` table
  (the founder-voice roadmap projects each arc onto a GitHub milestone; exactly one arc is
  `active` at a time — ADR
  [0078](https://github.com/kamp-us/phoenix/blob/main/.decisions/0078-product-driven-decisions-by-default.md)).
  An operator's explicit `work milestone N` still overrides it (the mode below). When **no**
  `## Arcs` row is marked `active`, there is no active milestone and this degrades cleanly
  to plain oldest-first. Because the tiebreaker lives *inside* a bucket, it can only reorder
  equal-priority issues — it can never pull a lower-priority in-milestone issue ahead of a
  higher-priority one.

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
dependency constraints the bare issue doesn't show.

Resolve the parent through **`GET /repos/{owner}/{repo}/issues/<N>/parent`**, the dedicated
sub-endpoint ADR
[0131](https://github.com/kamp-us/phoenix/blob/main/.decisions/0131-epic-autoclose-on-all-children-closed.md)
§3 already names the authoritative linkage — and read **three** outcomes off it, never two:

```bash
# stdout IS the classification — an empty one is UNKNOWN, never "standalone". On a sub-issue its
# first line is `EPIC=<n>`: that number, and never a guessed or remembered one, is Step 2's argument.
bash ./.claude/.pipeline/skills/write-code/scripts/step1-parent-resolve.sh <N> || exit 1
```

- **Parent resolved (200)** → go to **Step 2** and derive eligibility before claiming.
- **Standalone (404)** → skip to **Step 3**.
- **Anything else** → **stop, loudly.** An unreadable parent read is *unknown*, not *absent*;
  proceeding would claim a child whose dependencies were never checked.

> **Never read `.parent` off the plain issue payload.** The single-issue REST response carries
> **no** `parent` key at all (the linkage surfaces there as `parent_issue_url`), so the read this
> step used to carry — a `--jq` on `.parent` with a `"no parent (standalone)"` jq-alternative
> default — fired its default unconditionally and answered "standalone" for *every* issue: a
> well-formed, plausible, always-wrong answer that skipped the whole Step 2 derivation on every
> epic child and left no trace (#4171). ADR 0131 §3 states the same thing from the other side:
> the child's own `.parent` field is unreliable, the sub-endpoint is the source of truth.

---

## Step 2 — Sub-issue eligibility (derive blockedness, never read a label)

For a sub-issue, **read the parent epic first** — its plan, its `## Dependencies`
topology, and its progress (the handoff-note comment stream). A child is only pickable
when its dependencies are all closed. There is **no `status:blocked` label**;
eligibility is computed fresh on every pick from the epic's `## Dependencies` section.

```bash
# pass the parent number Step 1's sub-endpoint read RESOLVED (its `EPIC=` stdout line) — never a
# guessed or remembered one. No topology read ⇒ UNKNOWN, never "no dependencies".
bash ./.claude/.pipeline/skills/write-code/scripts/step2-epic-read.sh <EPIC> || exit 1
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

## Step 3 — Claim by writing your session-id claim marker (the agent-distinguishable claim, ADR 0115)

Claiming backs Step 1's "skip assigned issues" rule so other write-code agents step over a
claimed issue. But the bare GitHub assignee **cannot** be the claim: it is **last-write-wins,
additive, not compare-and-swap** (two agents that both saw #N unassigned co-assign `[A, B]`,
#260) — and worse, **every draining agent here pushes as the single git identity `usirin`**,
so the old `min(login)` tiebreak degenerated to a no-op (both co-racers compute
`min == usirin == me` and both implement #N; the #1431 double-implement). The fix is the
**agent-distinguishable claim marker** (ADR
[0115](https://github.com/kamp-us/phoenix/blob/main/.decisions/0115-agent-distinguishable-claim-marker.md), #1452):
a claim **comment** stamped with your `CLAUDE_CODE_SESSION_ID`, the per-agent UUID the
runtime exposes that the shared login cannot provide.

**Single-source the primitive — do not re-derive it.** The canonical claim-comment grammar,
the `CLAIM_RE` matcher, the write+ ACL trust root (ADR 0055), and the earliest-authorized-claim
tiebreak are defined once in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7
(the agent-distinguishable claim marker). This step is the **issue-claim consumer** of that
primitive — it writes the claim and resolves ownership by §7's rules; it never invents a second
grammar or a second `CLAIM_RE`. The marker is the one line:

```
claim: <CLAUDE_CODE_SESSION_ID> · <ISO-8601-UTC>
```

The claim is **two layers** (§7): the **assignee** stays as the coarse, login-blind
availability gate the Step-1 picker reads (`skip on any non-null assignee`), and the
**session-id claim comment** is the fine, agent-distinguishable resolver. You self-assign
*and* post the claim comment; the comment, not the assignee, decides who owns the work.

**Both layers get written on both paths.** Layer one is owed by whoever wins the claim — the
dispatcher on the delegated path, you on the direct path — and **you re-assert it, idempotently,
once your claim is confirmed**, so the gate is set for the whole build whatever dispatched you
(§7 [Who writes layer one](../gh-issue-intake-formats.md#who-writes-layer-one-the-claim-winner-on-both-paths),
#4298). Both branches below end with the same one-line ensure.

### Delegated claim — the orchestrated path (recognize, don't re-race)

If the orchestrator (`.claude/workflows/drive-issue.js`) claimed pre-spawn and **threaded a
claim token into your prompt** ("your delegated claim token is `<token>`"), the claim is
**already yours** — the orchestrator posted it on your behalf (ADR 0115 §3, Delegated
ownership). Do **not** post a second, redundant claim and do **not** re-race. Confirm the
delegation by resolving §7's tiebreak once — the **earliest authorized claim**'s embedded
session id must equal the threaded token — then proceed straight to implementing:

```bash
# pass the token the orchestrator threaded into your prompt; non-zero ⇒ delegation NOT confirmed,
# do not implement
bash ./.claude/.pipeline/skills/write-code/scripts/step3-delegated-claim.sh <N> "<threaded token>" || exit 1
```

### Direct path — claim it yourself (no orchestrator)

When `write-code` is invoked directly (no threaded token), make the claim here, before you
branch or build, using your own `CLAUDE_CODE_SESSION_ID` as the token:

The whole claim-comment write — Rule-0 defer, the POST, the checkpoint-GET tiebreak, and
retract-on-loss — is owned by **one verb**, `pipeline-cli tracker claim` (§7's write surface).
Run it; never hand-roll a `claim:` body, which silently skips the ADR-0191 presence stamp and
leaves this lane's claim permanently unprobeable (#3987):

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/step3-direct-claim.sh <N> || exit 1   # non-zero ⇒ NO claim was made; back off and re-pick
```

**The operating rule.** Posting the claim comment **detects** a race; the **checkpoint GET**
(re-reading the issue's comments and resolving the earliest authorized claim per §7) **resolves**
it — the verb does both, and neither leg is prunable as "redundant" (without the checkpoint both
staggered co-racers proceed, a double-pick). The winner is the **earliest authorized claim** (min
`created_at`, then min comment `id`) whose claimant is not provably dead, recognized because its
embedded session id equals your `CLAUDE_CODE_SESSION_ID`; because earliest-claim-wins, Rule 0
(defer to a pre-existing owner) and the tiebreak are **the same fact**. Every loser retracts its
**own** claim comment (the verb's own last act) and, having claimed before assigning, has no
assignment to undo — it just re-picks. Never co-occupy, and **never** delete another agent's claim,
**never** unassign a slot you did not fill, and never fall back to the login-keyed assignee as
ownership. This is **detect-and-tiebreak, not a lock**; the residual transient window — a claim
already posted while the assignee is not yet set — is tolerated, because an agent that picks the
still-unassigned issue in that window runs the verb and defers to the earlier claim.

See [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §7 for the canonical
`CLAIM_RE`, the full write+-ACL resolution snippet, the staggered-co-racer / straggler / transient
derivation, and the pre-spawn / delegated-ownership protocol — this step implements that contract,
it does not re-derive it.

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
# prints `MY_CLAIM=<token>`; refuses (fail-closed) when neither token is set. Read it to SEE which
# token this lane owns work under — every guarded site below resolves the SAME token internally,
# because a shell variable does not survive to the next Bash call.
bash ./.claude/.pipeline/skills/write-code/scripts/step3_5-my-claim.sh || exit 1
```

### The guard script — MANDATED before every issue/PR-number mutation

Gate **every** number-targeting mutation on it, exactly as
[the worktree preflight](#per-mutation-preflight) gates every git mutation — a green run is the
**only** sanctioned path to a mutation that names `<N>`, no bypass. Its **exit status is the entire
contract**; it prints nothing on stdout, so never read its text for the answer:

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/step3_5-claim-is-mine.sh "<N>" || exit 1
```

The calling convention, which every number-targeting mutation below follows:

```bash
# the guard gates the mutation; never run the mutation without it
bash ./.claude/.pipeline/skills/write-code/scripts/step3_5-claim-is-mine.sh "<N>" \
  && gh api repos/$REPO/issues/<N>/comments -f body="…"
```

The guard is **fail-closed by construction** — the verb proceeds (exit 0) **only** on positive
evidence of an authorized claim whose session is `MY_CLAIM`; an absent claim, an unauthorized-only
claim, and a foreign claim all resolve not-mine and **refuse** (exit non-zero). It is **observable**
(the verb prints the resolved owner vs `MY_CLAIM`, the outcome reason, and any **superseded**
dead-claimant claims) and **idempotent** (a read-only GET). **Never** route around it by widening
the comparison or treating the bare assignee as the owner — the assignee is a coarse availability
gate only (ADR 0115 §1), and a login-keyed ownership check is the degeneracy this guard exists to
remove. **A refusal is also never overridable by reasoning**: an explicit-looking dispatch brief,
or independently re-deriving that the PR/branch/issue/verdict all line up, establishes that the
*dispatch was coherent* — not *who owns the lane*. Proceeding on that corroboration is what made
the guard advisory in the field (#3751); the only sanctioned response to a refusal is to stop and
surface it to whoever dispatched you.

**Ownership resolves against the earliest *live* authorized claim (ADR 0191 supersession).** The
verb drops a claim whose claimant is **provably dead** — its marker's presence stamp names a
session process this host can probe, and the process is gone — so a dead session's older marker no
longer shadows a legitimate later claim on an abandoned lane (the orchestrated-repair case, #3751).
Supersession needs **positive evidence of death**: an unstamped/legacy marker, a claim stamped on
another host, and an unprobeable pid all stay indeterminate, still count as owners, and still
refuse. So the guard's fail-closed direction is unchanged — what changed is that the *legitimate*
case can now resolve, instead of being permanently unprovable.

> **Which `<N>` to guard at each site.** The guarded number is the **work-target whose mutation
> could clobber another agent**: Step 5 guards the **issue** you open the PR against; Step 6 the
> **issue** you comment on; **Step 7 guards the child you own** (the handoff to the parent epic is
> predicated on owning the child — gate on the **child** number, not the epic, which you never
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
   and reaches a mutation. The guard run on `900` resolves `winner = B-sid`; `B-sid != A-sid` ⇒
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
# stdout is `GITDIR=` / `COMMON=` / `WT=`; the scope line, the LOUD refusals and the CONFIRMED
# assertion are on stderr. `exit 1` on every unsafe state, with NOTHING on stdout. `WT=` is the one
# you act on: anchor every later Edit/Write and git op to that absolute root.
bash ./.claude/.pipeline/skills/write-code/scripts/step4-preflight.sh || exit 1
```

The preflight is **fail-closed by construction**: it refuses on the primary checkout, on a
not-a-repo cwd, *and* on the ambiguous default — only positive evidence of a linked worktree
(git-dir ≠ common-dir) lets it through. It is **observable** (it prints the two dirs + cwd +
`isolation-expected` it compared, so "what did the preflight look at" is answerable from the run
log) and **idempotent** (read-only `git rev-parse`, safe to re-run). **Never** route around the
preflight by deleting it or relaxing the comparison; a green preflight is the precondition every
mutation in Steps 4–7 relies on.

**The primary-checkout refusal forks on whether isolation was *expected* (ADR 0172, #2443).** The
`git-dir == common-dir` refusal is a hard stop in both directions, but *how* you're meant to
recover differs, and conflating the two is what let a harness failure hide:

- **Isolation was EXPECTED** (`isolation-expected=1` — the run is under the coder agent-type, or
  `$WORKTREE_ROOT` was set) yet you're on the primary checkout ⇒ **fail closed LOUD and STOP.**
  This is the [#2440](https://github.com/kamp-us/phoenix/issues/2440) harness no-op: the harness
  was supposed to provision a linked worktree and inject `$WORKTREE_ROOT` but silently didn't, which
  *also* disarms the whole `$WORKTREE_ROOT`-keyed repo-side worktree-guard — so this preflight is
  the only surviving layer. **Do NOT self-provision to route around it.** Self-provisioning here
  would paper over the harness failure and leave the two-layer primary-corruption defense collapsed
  to one, *invisibly* (the [#2270](https://github.com/kamp-us/phoenix/issues/2270)
  primary-checkout-corruption class). Instead surface the printed **ROUTED BLOCKER** up to the
  operator/EM so the out-of-repo harness half gets fixed rather than silently absorbed.
- **Isolation was NOT expected** (`isolation-expected=0` — a genuine standalone `write-code`, e.g.
  a human running `/write-code` directly) ⇒ take the [Non-isolated fallback](#non-isolated-fallback)
  below, which creates a real linked worktree and `cd`s into it, after which this same check passes.
  This is the **only** path where self-provisioning is sanctioned; the loud branch above never fires
  for it, so the standalone flow is unchanged.

The `isolation-expected` signal is **machine-checkable and grounded in the coder agent-type's
unconditional-isolation assertion** ([`../../agents/coder.md`](../../agents/coder.md)), read from the
harness-set `$CLAUDE_CODE_AGENT` env (stable across an agent's separate Bash calls) plus a set
`$WORKTREE_ROOT` — never a per-run guess. It **fails safe**: if the agent-type value ever differs from
what's matched, the run degrades to `isolation-expected=0` (today's silent self-provision), never to a
dangerous primary-checkout mutation — the loud branch only *adds* a stop, it never removes the
existing refusal.

**The success path asserts worktree identity LOUDLY, on env-independent evidence (#3458).** When
`git-dir != common-dir` the preflight no longer proceeds *silently*: it captures `$WT` from that
positive git-plumbing evidence and prints a `CONFIRMED` line naming the worktree root. This is the
producer/preflight half of the worktree-misID class — a worktree-isolated spawn is handed a
**misleading process env** (`$WORKTREE_ROOT` unset because the #2938 provisioning hook was reverted;
`$CLAUDE_CODE_AGENT` carrying the *parent's* agent-type via inheritance, #2462), so neither env var
can anchor "am I in my worktree?" The `git-dir != common-dir` plumbing can, and the assertion keys on
*only* that — never on an agent-type string, so no fix relocates the fragile coupling (the same
principle as #3406's ADR 0189 note). **This is deliberately distinct from #3406.** #3406 is the
**consumer/failure-side** change: it re-keys the `ISOLATION_EXPECTED` *detector* (the
`case "$CLAUDE_CODE_AGENT"` on the `git-dir == common-dir` branch above) onto the same env-independent
primary-checkout corroboration, to parity with `bash-pin.ts`. This issue is the **positive/success-side**
assertion. The two live on **opposite sides of the same `if`** and do not overlap: #3406 hardens *when
to fail closed*, #3458 hardens *what a pass positively establishes*. The `ISOLATION_EXPECTED` detector
is intentionally left untouched here so the two changes can't double-implement or contradict.

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
> Run this **mandatory per-mutation preflight** — `wt_preflight` — *immediately before* every
> `git commit`, `git push`, and branch create/switch (Steps 4, 5, R2, R3). It first asserts that
> the tree the cwd is *currently* in is not another lane's, then resolves **your** worktree from
> the lane stamp the opening preflight wrote and **prints that root on stdout**. A green
> `wt_preflight` is the **only** sanctioned path to a mutation — no bypass, same fail-closed
> construction as the opening preflight:
>
> ```bash
> WT="$(bash ./.claude/.pipeline/skills/write-code/scripts/step4-wt-preflight.sh)" || exit 1
> git -C "$WT" <commit|push|switch …>   # address git at the root the guard resolved; never mutate without it
> ```
>
> **The guard decides; you apply.** The script is *executed*, not sourced (ADR 0232), so it cannot
> `cd` your shell for you — a subprocess never changes its parent's directory, and ADR 0232 retires
> leave-state-in-the-caller's-shell as a design property outright. What moved is the **effect**, not
> the decision: every classification and every refusal still runs inside the script, its narration
> goes to stderr, and stdout carries exactly the resolved root. Correcting a between-calls cwd reset
> is then the caller's one obligation — **address git at `$WT` explicitly**, never rely on where the
> cwd happens to be. An empty `$WT` is a refusal, so `|| exit 1` is what keeps that fail-closed.
>
> **What makes it able to fail, stated so a future editor can check it.** Both refusals compare
> operands from different origins: a **stamp file** written when a worktree was proven, against the
> **process env**. Put cwd in a sibling lane's tree and they differ, so the refusal prints. The
> assertion this replaces compared `git rev-parse --show-toplevel` against `git rev-parse
> --show-toplevel` run in the same directory after a `cd` to it — always equal, so its failure
> message could never print.
>
> **The rule is about where the operands come from, not about where the line sits.** An assertion
> that re-derives the value the resolution just produced — asking the cwd where the cwd is — is true
> by construction and is not a guard; that, specifically, is the defect above. An assertion whose
> operands come from somewhere else is a real guard wherever it sits, **including after the lane is
> resolved**: the script's primary-checkout refusal tests `lane_worktree`'s *answer* with two
> different plumbing queries (`--absolute-git-dir` vs `--git-common-dir`) that coincide only on the
> primary, and it fires on a `worktrees/<name>/gitdir` naming the primary root. So never delete a
> later assertion merely because it follows the resolution — check its operands first.

<a id="anchor-edits-to-wt"></a>
> **Anchor EVERY `Edit`/`Write` to `$WT` — the raw-write path no git guard covers (#3458).**
> `step4-wt-preflight.sh` and the repo-side worktree-guard both gate **head-moving git ops**. A raw
> `Edit`/`Write` to a file is **not** a git op, so **neither guard fires on it** — an edit whose
> target is a **primary-checkout absolute path** writes straight into the shared primary tree,
> silently, and is caught (if at all) only by a coder noticing the primary went dirty before commit.
> This is not hypothetical: with `$WORKTREE_ROOT` unset and the cwd reset to the primary checkout
> between calls, a coder's *first* `Edit`/`Write` took primary-checkout absolute paths from session
> `gitStatus`/`Read` context and landed edits on primary `main` (#3458 sharpening) — the guards never
> saw it because it wasn't a git op.
>
> So the opening preflight's `$WT` capture is load-bearing for **file edits, not just git ops**:
> **every `Edit`/`Write` target path MUST be under `$WT`** (the absolute worktree root the preflight
> `CONFIRMED`), never a bare primary-checkout absolute path — even one the harness handed you in
> `gitStatus` or a `Read` result. The Edit/Write tools do **not** auto-target the worktree; an
> absolute path outside `$WT` edit-bleeds into whatever tree it names. Before the first edit, know
> `$WT`; for every edit, confirm the path begins with `$WT`. Treat a primary-checkout absolute path
> in your context as **stale** (cwd-reset + Read-cache), not as your worktree.

<a id="pushing-the-verdict-is-the-ref-not-the-exit-code"></a>
> **Pushing: the verdict is the ref, not the exit code — always `pipeline-cli verified-push` (#4213).**
> A push is the one mutation whose failure is **invisible by default**, and not because of git.
> Two observation-layer defects destroy the signal independently: piping a push through `tail`
> reports `tail`'s status (`pipefail` is **off** on this platform, measured — so the pipeline
> returns 0 however git died), and a **detached** run's output file carries **no exit status at
> all**, so success gets inferred from the absence of an `error:` line — which is exactly what a
> SIGPIPE'd git, printing nothing, looks like. Both fired on one lane (#4042 / PR #4142): the
> branch simply was not there, and every downstream stage — reviewer checkout, SHA-bound verdict,
> shipper merge — assumed a branch that did not exist.
>
> So **never invoke git's push porcelain directly from this skill.** Use `pipeline-cli
> verified-push`, which pushes and then reads the remote ref back independently, and emits its
> verdict as a single grep-able line **last on stdout** — `PUSH-VERDICT: MOVED`, `NOT-MOVED`, or
> `UNKNOWN` — *in addition to* the exit code (0 / 1 / 3). stdout is the one channel that survives
> **both** masking layers, so `… | tail -1` now yields *exactly* the verdict instead of erasing
> it, and a detached run's output file ends with it.
>
> **Three outcomes, and the third is not a success.** `MOVED` means the remote ref was confirmed
> at your local head. `NOT-MOVED` means it was confirmed *not* to be. `UNKNOWN` means the probe
> could not determine it — a dead transport, an unresolvable head, a ref that matches while the
> push itself misbehaved. Treat `UNKNOWN` exactly like a failure: **stop and surface it.** Do not
> re-run the push hoping it takes (the verb deliberately does not retry — a blind retry hides the
> contention it exists to expose, #4136), and do not proceed to open a PR, request a re-review, or
> report the work landed.
>
> This is enforced mechanically, not by attention (ADR 0202): `pipeline-cli gh-phoenix lint-skills`
> reds on a git push invocation in any runnable block of the skill corpus and fails closed on zero
> scope, so a bare push cannot re-enter this file.

This constrains how you branch: `main`
is already checked out in the primary tree, so `git checkout main` **fails** inside an
isolated worktree (`fatal: 'main' is already checked out at <primary>`). Branch from
latest origin `main` **without checking it out**:

```bash
# prints `BRANCH=<name>`; no branch on non-zero. Read the name only to SEE it — every later git op
# RE-DERIVES the branch live from the worktree HEAD (below).
bash ./.claude/.pipeline/skills/write-code/scripts/step4-branch.sh <slug-for-issue-N> || exit 1
```

It's `git switch -c "$BRANCH" FETCH_HEAD` (not `git checkout main`) on purpose: in an
isolated worktree `main` is checked out elsewhere, so branching directly off the
freshly-fetched `FETCH_HEAD` is the only flow that works — don't "fix" it back to a
`main` checkout.

<a id="branch-name-is-re-derived-live"></a>
> **The branch name is created once here, then RE-DERIVED LIVE from the worktree at every
> later git op — NEVER carried across Bash calls in a shared file.** `$BRANCH` is a shell
> variable, and shell state does **not** survive between an agent's separate Bash
> invocations (env vars are gone by the next call, the same way the cwd is reset back to the
> primary tree — which the per-mutation preflight corrects). So by push time (Step 5)
> `$BRANCH` is **empty**, and an agent that "carries" it by writing the name to a scratchpad
> file improvises a **cross-lane hazard**: a plain `/tmp` (or shared-scratchpad) path like
> `branch.txt` is **unkeyed**, so a concurrent lane clobbers it mid-run and the reader
> pushes to the **sibling lane's ref** (#2038 — the #2018 lane pushed toward the #2021
> lane's branch). The `uuidgen` nonce makes each lane's *value* unique, but a shared
> *filename* is what collides.
>
> **The rule (mandatory, at every git op after this create): re-derive the branch live from
> your own worktree — never read it from a file.** The branch checked out in the worktree
> `step4-wt-preflight.sh` just resolved **is** your work branch, so read it straight from that
> worktree's HEAD:
>
> ```bash
> WT="$(bash ./.claude/.pipeline/skills/write-code/scripts/step4-wt-preflight.sh)" || exit 1
> BRANCH="$(git -C "$WT" branch --show-current)"   # live from the worktree — the source of truth, re-read at each git op
> : "${BRANCH:?could not re-derive branch from worktree $WT — refusing to push to a guessed/cached ref}"
> ```
>
> This is exactly the recovery the reported incident used to self-heal, promoted to the
> standing rule. **Do NOT** persist the branch name to a scratchpad/`/tmp` file to carry it
> across calls. This is the local instance of the **per-run scratchpad namespace**, §SP of
> [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) — and it is §SP's *first*
> rule, "prefer no file at all," which the live re-derivation above satisfies outright. If — and
> only if — a per-run cache is genuinely unavoidable, allocate it under `$RUN_SCRATCH` per §SP
> (never a bare `branch.txt`, and never a path keyed only on the issue number). The reason this
> matters beyond a mis-push: a clobbered scratchpad file **reads back successfully** with the
> sibling lane's content, so nothing errors and the wrong ref looks right (#2038, and the #3718
> reviewer that diffed the wrong PR).

The prefix is **derived** from this checkout's `git config user.name`, not a copied literal —
so the branch lands under *your* handle (`<your-handle>/…`), whoever runs the skill, instead
of inheriting someone else's namespace. Append a short kebab-case slug naming the work and the
per-run nonce so two concurrent runs on the same issue never push the same `origin/` ref. Read the issue's `### What to build` for scope
and honor the `**TDD:**` flag — `yes` means write the failing test first, then make it
pass; `no` means config/docs/scaffolding where test-first doesn't apply.

As you write, apply CLAUDE.md's "Comments earn their place or die" collapse convention to
the code you generate: state a *why* once at its most load-bearing site and point elsewhere
with `// See ADR NNNN` / `#NNNN` — never re-derive the same ADR rationale across multiple
docblocks in a file (the `coder.md` standing invariant is the source; #2186).

<a id="non-isolated-fallback"></a>
> **Non-isolated fallback.** For the rare invocation that isn't already in a worktree,
> spin one up rather than checking out `main`. **Fetch first** — the local `origin/main`
> remote-tracking ref can predate a just-merged base commit (e.g. a run-evidence-referenced
> tooling file added seconds before branch-cut), so `git worktree add … origin/main` off a
> stale ref cuts a head that misses that file and false-fails the SHA-bound CI (#1920; the same
> stale-base class #1837 fixed at the repair step). Create the worktree on the per-run
> `$BRANCH` (nonce and all) at a per-run worktree path off the **freshly-fetched** tip, so two
> concurrent fallback runs collide on neither the branch nor the dir: `git fetch origin main;
> WT="../wt-issue-<N>-$(uuidgen | head -c 8)"; git worktree add -b "$BRANCH" "$WT" FETCH_HEAD`,
> then `cd "$WT"`. Branch off `FETCH_HEAD` (the just-fetched origin tip), **never** the possibly-stale
> `origin/main` ref. When you're done, remove it with `git worktree remove "$WT"` (never
> `--force` — a dirty tree then errors out and is KEPT). A build worktree that made commits and
> is *not* removed here (an aborted run, a fallback that never reached its done-step) does not
> leak unbounded: it is backstopped by `pipeline-cli worktree-sweep --execute` (#1243/#2785),
> which reclaims a `.claude/worktrees/` build tree only once it is clean + merged + idle +
> unlocked with no open PR — the #2240 liveness guard, non-`--force`. After the `cd "$WT"`, **re-run the Step 4 preflight** — the
> fresh worktree's git-dir now differs from the common dir, so the check passes and you may
> mutate. This fallback is **only for the standalone (`isolation-expected=0`) path** — a run where
> isolation was *expected* must NOT reach it: the preflight's loud branch (ADR 0172, #2443) hard-stops
> that case *before* here, because self-provisioning would silently absorb a harness provisioning
> failure (#2440) and collapse the two-layer defense to one. For a standalone run this is the only
> sanctioned route from a primary-checkout start; the preflight stays fail-closed until a real
> worktree exists. Here too the branch name is **created once**
> and thereafter **re-derived live** from the worktree (`git -C "$WT" branch
> --show-current`) at each later git op — never carried across Bash calls in a shared file
> (see [the live-derivation rule](#branch-name-is-re-derived-live) above; the same
> cross-lane clobber applies to a fallback run).

Ground the implementation in the codebase the way the repo expects: the ADRs in
`.decisions/` are the *why* and the binding decisions, the patterns in `.patterns/`
are *how the current code is shaped* — read the relevant ones before writing, and
follow them over intuition (per `CLAUDE.md`). Implement the issue's acceptance
criteria; they are the literal checklist `review-code` will verify, so build to make
every box checkable from the outside. Run the **pre-push typecheck** (below) and the
test suite as the repo conventions require before you open the PR.

### Pre-push typecheck — run the EXACT CI command (`pnpm typecheck`), never a hand-rolled `tsc`

Run **`pnpm typecheck`** — the *exact* command CI's `lint / format / typecheck` job runs
(`.github/workflows/ci.yml`) — and **refuse to push on any non-zero exit.** This is the
**only** typecheck that predicts the gate, because it is *byte-for-byte the gate's own
command*:

```bash
pnpm typecheck
```

`pnpm typecheck` fans out (`turbo run typecheck`) to each app's project-aware checker — for
`apps/web` that is `pnpm fate:generate && tsgo -b tsconfig.worker.json tsconfig.node.json &&
tsgo -p tsconfig.app.json …` — so it covers the **full workspace under the real project graph,
including every newly-added test file**, with the repo's strict flags
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) in force. **Do NOT** substitute a
hand-rolled `tsc -p tsconfig.json` (or any bare `tsc`): the repo's checker is **`tsgo`**
(`@effect/tsgo` / `@typescript/native-preview`), a *different engine* than stock `tsc`, and a
root-`tsconfig.json` `tsc` run uses a *different, partial project scope* that **omits the
app's test files** — so a type error in a new test file passes your self-check and only
surfaces when CI (or `review-code`) re-runs the real `pnpm typecheck` at head, costing a full
FAIL → repair round-trip the pre-push gate exists to prevent (#1479; the #1406 / #1407
incidents — new test files that failed `TS18048` / `TS2412` / `TS2345` only under the gate's
`tsgo`). **New test files are full TS under the same flags and the same project as production
code — a test-file type error is a real gate failure, not noise.** So run `pnpm typecheck`
**after your final test edits**, over the whole workspace, and treat a non-zero exit as a
hard "do not push" — never report "typecheck clean" off a narrower or different-engine run.

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

Commit per repo conventions, gating each `git commit` on `step4-wt-preflight.sh` (the
[per-mutation preflight](#per-mutation-preflight) above) so a between-calls cwd reset can't
land the commit on the primary tree. Don't push to or PR from `main`.

---

## Step 4a — Read the four-pillars design law before you generate any UI (UI diffs only)

When this diff will **generate or edit a user-facing UI surface**, read
[`design-system-manifest.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-manifest.md)
**before you author the UI**, and generate to it — role-token annotations, component-selection
rules, and the per-pillar prohibitions. That manifest is the agent-readable transcription of the
four-pillars design law (ADR
[0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md)) —
the CLAUDE.md-for-design a UI-generating agent applies from the first draft. This is the read-*before*
counterpart to Step 4d's look-*after* self-check and Step 4e's prose-before read: consult the law on
the way *in* so the generated UI conforms from the start, rather than leaving `review-design` to catch
a pillar violation after the fact. Making this an explicit step closes the build-vs-review asymmetry —
`review-design` binds the manifest explicitly at gate time, so the build side must too, not rely on
CLAUDE.md happening to name the file.

**Fires only for a UI diff — a no-op otherwise (graceful absence).** Scope it to a diff that changes a
rendered frontend surface (`apps/web/src/**`, the same probe as Step 4d); a worker/tooling/docs/skill
diff authors no UI and skips this step entirely — the same first-class-absence shape as Steps 4b/4d/4e.

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
# prints `CONTAINMENT=<flag|exempt|none>` — the first of Step 4b's two inputs
bash ./.claude/.pipeline/skills/write-code/scripts/step4b-containment.sh <N> || exit 1
```

**Graceful absence — the dark-ship behavior applies only when there's a cycle.** It fires **only**
when the marker resolves to `flag` *and* the repo has a `product-development-cycle.md` (the one
canonical probe, formats §1). On `exempt`, `none`, a missing line, or an **absent** cycle doc (a
foreign install with no cycle and no flag substrate — ADR
[0062](https://github.com/kamp-us/phoenix/blob/main/.decisions/0062-repo-as-config-plugin.md)), this
step is a **no-op**: you implement and ship the change exactly as Steps 4/5 already describe, with
**no flag introduced**. Absence is a first-class, correct state, not a defect — the same
graceful-absence contract `plan-epic` (stamp) and `review-code` (verify) honor.

```bash
# the canonical cycle-doc probe (formats §1) — relayed to the SHARED script, never copied; stdout is
# `present` or `absent`. Absent ⇒ no cycle ⇒ ship normally, no flag.
CYCLE_DOC="$(bash ./.claude/.pipeline/skills/write-code/scripts/step4b-cycle-doc.sh)" || exit 1
# ship dark ONLY when:  [ "$CONTAINMENT" = flag ] && [ "$CYCLE_DOC" = present ]
```

That probe is the **shared** `skills/shared/scripts/cycle-doc-probe.sh` — not a skill-local copy —
and the relay above **sources it in-script**, which is the one sourcing form ADR 0232 leaves
sanctioned and the same way `plan-epic` and `review-code` reach it.

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
fact that flows out of this step — and it flows as **text you carry into Step 5's body**, not as a
shell variable. `$FLAG_KEY` is gone by the next Bash call, so no later step may branch on it (#4398);
Step 5's dark-ship check re-derives whether this step fired from the issue's `Containment:` marker.

The load-bearing invariant the patterns own is **default =
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

## Step 4c — Self-deslop your own freshly-generated diff (a cheap pre-push pre-pass, never a gate)

Before you push (Step 5), run the **`deslop-comments` discipline over the lines this diff
changed** — and only those lines. AI-generated code reliably over-comments: narration of
obvious control flow, comments that restate the symbol they sit on, separator/banner
comments, and docblocks that re-derive a *why* an ADR already owns. CLAUDE.md's "Comments
earn their place or die" is the standing rule. This step is a **cheap author-side pre-pass**
that cuts the obvious slop before push — but it is **no longer the enforcement**: the
authority that keeps slop out of merged diffs is now the **independent `review-code`
comment-discipline gate** (Step 3d of `review-code`, ADR
[0119](https://github.com/kamp-us/phoenix/blob/main/.decisions/0119-comment-discipline-is-an-independent-review-criterion.md)).
Running it here is still worth it (every line you cut is one fewer the gate FAILs on, saving
a repair round), but the bias-removing judge is the fresh-eyes reviewer, not you.

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

After deslopping, commit the comment-only change (gate it on `step4-wt-preflight.sh` like every other
commit) so the pushed head carries the cleaned diff.

> **This is a self-check, not the gate — the split-role firewall holds.** Deslopping your
> *own* diff before push is exactly the "re-reading your own diff to self-check before you
> push is fine" carve-out from the intro. It is a self-edit, not a review: you do **not**
> run `review-code`/`review-doc`/`review-skill` on your PR, and you do **not** emit a
> `review-*` verdict marker. The independent gate still judges the result with fresh eyes —
> this step only keeps the wall out of what it judges.

> **Placement rationale — superseded by ADR 0119 (the enforcement moved to the gate).** #1348
> first wired the deslop discipline here as the author's self-check *and* the sole enforcement —
> placement (a) over a `review-code` finding (b) or both (c) — arguing comment density was "a
> self-correctable authoring concern, not a correctness contract the gate must adjudicate." That
> premise was **falsified** by merged-PR evidence (#1380/#1378 landed ~29% comment lines despite
> Step 4c running): self-deslop is **author-biased** — the agent that just wrote each justification
> is the worst judge of its own slop, the same self-evaluation bias the pipeline pays a separate
> reviewer to remove for correctness. ADR
> [0119](https://github.com/kamp-us/phoenix/blob/main/.decisions/0119-comment-discipline-is-an-independent-review-criterion.md)
> resolves #1394 by moving the **judging authority to the independent `review-code` gate** (its
> Step 3d, a standing diff-hygiene criterion like `lint`/`typecheck`), where fresh eyes remove the
> bias by construction. Step 4c is **retained but demoted** to the cheap author-side pre-pass above
> — it cuts obvious slop early so fewer repair rounds are spent on it, but it is no longer *the*
> enforcement. The firewall is unchanged: the gate judges, the author fixes via the normal repair
> loop, an independent re-review re-gates.

---

## Step 4d — Render→look→fix: the composition self-check (UI diffs only)

When this diff touches a **user-facing UI surface**, you self-verify the *assembled* result
before pushing: render the composed surface over a local build, **look** at the screenshot, and
fix composition defects against the four pillars — the same law `review-design` will grade
against (ADR
[0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md),
transcribed for agents in
[`design-system-manifest.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-manifest.md);
read it, don't re-derive the pillars here). This catches the class no per-slot check can:
**every slot is locally law-compliant yet the assembled page reads amateur** — the sözlük-subnav
detached-sibling smell (manifest §nav placement). The manifest's static prohibition pass (its
"How write-code consumes this" step 4) verifies each *part*; only looking at the render verifies
the *whole*.

**Fires only for a UI diff — a no-op otherwise (graceful absence).** Scope it to a diff that
changes a rendered frontend surface (`apps/web/src/**`); a worker/tooling/docs/skill diff has no
composed surface to look at, so this step is skipped entirely — the same first-class-absence shape
as Step 4b (`git diff --name-only origin/main...HEAD | grep -q '^apps/web/src/'`).

**The loop — render → look → fix:**

1. **Render** the composed surface over a running local `alchemy dev` build via the
   render-and-capture harness (#2963, the `@kampus/fabrika-cli/capture` local-render leg): it targets
   the local worker, renders against an **empty local D1** (designed-empty states are in scope — no
   seeding, per the founder v1 non-goal + security guard), honors the dev-override cookie so
   flag-gated UI renders, and writes a **cropped/downscaled** PNG of the changed region. Don't
   re-implement capture — invoke the harness.
2. **Look** at the rendered PNG and judge **composition/gestalt only** — balance, rhythm,
   alignment, hierarchy, whether the assembled surface hangs together as one page.
3. **Fix** the composition defects you see against the four pillars, then re-render.

**The encoded constraints — bounds, not suggestions:**

- **Cap at ~3 iterations.** Self-critique gains saturate fast; stop at ~3 render→look→fix passes.
  A composition still visibly broken at the cap is a note for your Step-6 progress comment, not a
  fourth loop.
- **Screenshot at decision points only, and evict stale images between iterations.** Capture only
  when you need to *decide* (the initial render, and after a fix you must re-judge) — not every
  edit — and **drop the prior iteration's image from context** once you've acted on it. Vision
  loops run 10–20× cost unbudgeted; the harness's crop/downscale is the capture-side budget, and
  evicting stale images is the **context-side** budget that complements it.
- **Gestalt only — spacing and contrast stay programmatic.** Judge *composition* by eye; **never
  eyeball pixel metrics.** Spacing, contrast ratios, and token correctness are verified
  programmatically (the manifest prohibitions, the design lint, the a11y loop, `pnpm
  lint:worktree`), never read off a screenshot — vision is unreliable at pixel measurement, reliable
  at gestalt.

### Reference-anchored generation — converge toward the blessed golden (blessed surfaces only)

For a **blessed surface** — one that carries a founder-blessed *golden* baseline — the plain
render→look→fix loop above has a stronger anchor than taste against the pillars: the exact visual
reference the surface is meant to match. Feed that golden into the loop so your output converges
**reference-vs-rendered**, not only clears the six ADR-0162 prohibitions (story 4). This is the
generation half of the golden-screen loop (epic
[#2955](https://github.com/kamp-us/phoenix/issues/2955), ADR
[0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md)):
the blessed golden set is the reference you generate *toward* here, and the same baseline the
independent `review-design` gate blocks *deviation from* — converging in authoring is what keeps that
gate from having to escalate (its counterpart golden-deviation class, #2967). Read `review-design`'s
golden-deviation section for the shared vocabulary — *golden*, *blessed surface*, *deviation* — and
stay consistent with it; do **not** duplicate its blocking logic here (this is a self-check that
converges, not a gate that fails).

**Scope — blessed surfaces only; an unblessed surface is unchanged.** Resolve the committed golden
pointer and intersect its blessed surface-ids with the surfaces this diff renders; only that
intersection gets the reference anchor. A changed surface **not** in the pointer has **no** golden —
it stays exactly the plain pillars loop above, with **no** new anchor and **no** new gating (the same
N/A the review side gives an unblessed surface). Never invent a reference for a surface the founder
never blessed. The pointer is the committed source of truth (`packages/design-capture/golden-pointer.json`,
its `surfaces` map keyed by the same `<route>[:state]` capture surface-id):

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/step4d-blessed-surfaces.sh   # prints `POINTER=<path>` then one blessed surface-id per line
```

**The reference-anchored loop — consume the seam, never re-implement the diff.** For each blessed
changed surface, resolve its golden through the `@kampus/fabrika-cli/capture` golden seam (the *one* notion
of "the golden for this surface", shared with the review side) and add a **compare-to-reference** leg
to render→look→fix:

- **Resolve the golden.** `resolveGoldenBytes(pointer, surfaceId)` → the golden bytes (an unblessed
  surface returns `null`, which is your "no reference, skip" signal — never an error), and
  `resolveGoldenUrl(pointer, surfaceId)` → the immutable depo image URL to **look at beside** your
  rendered capture. `loadGoldenPointer(POINTER)` gives the in-memory pointer; `blessedSurfaces(pointer)`
  and `resolveGoldenEntry(pointer, surfaceId)` list/inspect the blessed set. These are real exports —
  the pointer/diff ones from `@kampus/fabrika-cli/capture`, the two depo resolvers from phoenix's
  `@kampus/design-capture` — so call them; do **not** re-derive the pointer parse or the depo URL.
- **Look, golden beside rendered.** Judge composition/gestalt with the golden as the target, not free
  taste — does the assembled surface *read as* its blessed reference (balance, rhythm, hierarchy,
  placement)? If you want the objective magnitude/region signal, run the **same** deterministic diff
  the review side uses — `diffRasters(golden, candidate, {masks})` → `DiffResult` (`magnitude` in
  [0, 1] + differing `regions`) — as a *signal to steer by*, never re-implementing the raster compare.
- **Fix toward the golden, then re-render** — targeting the named deviation below.

**Name the specific golden the render deviates from (story 5).** On a deviation, the self-check
**names it** — the **surface-id** its golden anchors, plus *which* region/aspect drifts (the
`DiffResult.regions`, or the gestalt aspect you saw) — so each repair iteration **targets that named
deviation** instead of guessing. That naming is the whole point: convergence toward a reference the
loop can point at, not blind self-critique.

**The ~3-iteration cap still bounds it** (reuse the cap above — this compare leg does not add loops,
it *directs* the existing ones): a blessed surface still visibly deviating from its golden at the cap
is a note for your Step-6 progress comment naming the surface + residual deviation, not a fourth loop.
A **can't-resolve-the-golden** (a depo fetch fault from `resolveGoldenBytes`, distinct from the `null`
an unblessed surface returns) is a "couldn't anchor this surface" progress note — you fall back to the
plain pillars loop for it, never block on the unobservable.

This is a **self-check, not a gate — the split-role firewall holds** exactly as it does for Step 4c:
looking at your own render before you push is the sanctioned self-edit, not a review. You do **not**
run `review-design`/`review-code` on your PR and you do **not** emit a `review-*` verdict; the
independent `review-design` gate judges the assembled result with fresh eyes against the same four
pillars — and re-diffs the blessed golden itself (#2967), escalating an *unexplained* deviation to a
FAIL. This reference-anchored self-check converges toward that same golden before you push, so the
gate rarely has to escalate. It only keeps the obvious composition breaks out of what it judges,
saving a repair round. At PR-open the before/after captures attach to the PR — see Step 5's
evidence-attach.

---

## Step 4e — Author prose in the imported writing-craft house style (prose diffs only)

When this diff **authors prose a human reads** — a doc page, an error message, or a skill — read
the imported writing-craft skill for that surface **before you write the prose**, then author to it.
This is the doc-path analog of Step 4d: the same self-check shape, on the writing surface instead of
the render. It exists because the writing-craft skills were imported as **wired-in, not ambient** —
the settled integration-depth decision ([#3374](https://github.com/kamp-us/phoenix/issues/3374)):
write-code consults them on the way *in* so generated prose conforms to Diátaxis + Strunk from the
first draft, rather than leaving `review-doc`/`review-skill` to catch a mode-mix or an AI tell after
the fact. This is the authoring counterpart of the same manifest-before-UI read Step 4a makes for
design (`design-system-manifest.md`).

**Fires only for a prose-authoring diff — a no-op otherwise (graceful absence).** Scope it to a diff
that adds or edits one of the four surfaces below; a pure worker/frontend diff that authors no prose
skips this step entirely — the same first-class-absence shape as Steps 4b/4d. Read each import
straight from the pipeline skills dir (they ship with this plugin); a missing import degrades to a
skip for that surface, never a block.

**Route each surface to its import, and read it before authoring — all four Wave-1 imports:**

- **Any doc page** (an ADR under `.decisions/**`, a pattern under `.patterns/**`, `README`,
  `DEVELOPMENT.md`, or prose `*.md` outside `.claude/`/`.github/`/`.glossary/`) → read
  [`../diataxis/SKILL.md`](../diataxis/SKILL.md) and pick the **one** Diátaxis mode the page serves
  (tutorial / how-to / reference / explanation), then author it to hold that single mode — never let
  it drift into a second. This is the exact lens `review-doc` gates the page against, so converging
  here is what keeps the page from coming back a mode-mix FAIL.
- **The English prose itself**, on **every** surface above (the ADR/pattern body text, not just its
  shape) → read [`../writing-clearly-and-concisely/SKILL.md`](../writing-clearly-and-concisely/SKILL.md)
  and write to Strunk — clear, concrete, cut the fluff — while avoiding its catalog of AI tells. The
  TR/EN language law is untouched: this governs the **English** technical prose; Turkish product copy
  stays Turkish (`.glossary/LANGUAGE.md`).
- **Error copy** — the English source string a user reads when an operation fails, in
  [`apps/web/src/fate/wireMessages.ts`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/fate/wireMessages.ts)
  → read [`.patterns/error-copy-law.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/error-copy-law.md)
  and write each string to the voice-and-clarity law. It governs the copy's wording only; the
  registry structure and the no-leak codec it names stay their owners' — don't touch them here.
- **A skill** — a `skills/**/SKILL.md` or its supporting files → read
  [`../author-skill/SKILL.md`](../author-skill/SKILL.md) and write in the house idiom (the frontmatter
  `name`/`description` contract, the prose-first body, the imported writing-craft house rules) toward
  `review-skill`'s four rigor checks, so the gate passes on the first pass.

This is a **self-check, not a gate — the split-role firewall holds** exactly as it does for
Steps 4c/4d. Reading the writing-craft skills to shape your own prose before you push is the
sanctioned self-edit, not a review: you do **not** run `review-doc`/`review-skill` on your PR and you
do **not** emit a `review-*` verdict. The independent gate still judges the result with fresh eyes
against the same skills — consulting them in authoring is what lets it rarely have to escalate a
mode-mix or a slop tell it would otherwise FAIL.

---

## Step 5 — Open a PR that closes the issue

Open the PR with **`Fixes #N` in the body** so merging auto-closes the issue (this is
the seam `review-code` relies on: pass → merge → `Fixes #N` closes it). Use the issue
number you're implementing.

**Lead the body with a plain-language, human-first summary.** Before any technical
detail — the what-changed rundown, the `Fixes #N` seam, a `Flag:` line — open the body
with **2–3 plain sentences a reviewer or a passer-by can grasp on a skim**: what this PR
changes and why it matters, in prose, no jargon. The summary **precedes, never replaces**,
the technical body below it. This is the human-first-summary mandate from
[#3374](https://github.com/kamp-us/phoenix/issues/3374) — the same wired-in writing-craft
integration Step 4e authors to, so write the summary to
[`../writing-clearly-and-concisely/SKILL.md`](../writing-clearly-and-concisely/SKILL.md)
(clear, concrete, no AI tells).

**The AC-completeness gate — decide `Fixes #N` vs `Part of #N` from whether the diff satisfies
EVERY acceptance criterion (run this BEFORE you write the keyword).** The closing keyword is a
**scope claim**, not a formality: `Fixes #N` auto-closes the *whole* issue on merge, so it is
correct **only** when this diff delivers **every** one of `#N`'s acceptance criteria. Before you
write any keyword, **enumerate the linked issue's `### Acceptance criteria` and check them off
one by one against what this diff actually delivers** — the same checklist `review-code` will
grade against:

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/step5-acceptance-criteria.sh <N> || exit 1   # stdout IS the checklist — an empty one is UNKNOWN, never "no ACs"
```

- **All ACs met by this diff → `Fixes #N`** (the default full close, below).
- **Any AC unmet by this diff → `Part of #N`** (the §9 partial-split token, below) — you delivered
  a subset and a sibling lane or a follow-up will finish the rest, so `#N` must stay **open** on
  merge. Do **not** reach for `Refs #N` / `See #N` / a bare `#N` for the partial case: `Refs`
  arms **no** seam at all and jams `ship-it` Step 1 (#647). The one sanctioned partial token is
  `Part of #N`, which links the PR without closing.

This is the decision the recurring **over-claim defect** exists to force — a `Fixes #N` on a
partial delivery silently closes an issue with ACs undelivered, and the deferred half vanishes
from the tracker (PR #2414 over-claimed `Fixes #2270` on the prose-only half; PR #2420 over-claimed
`Fixes #2056` with the mechanism inert). The `Part of #N` *tool* already existed; this gate is the
*trigger* that makes you reach for it instead of over-claiming.

**When you defer ACs, capture the deferred half — it must not silently drop.** A `Part of #N`
keeps `#N` open, but the unmet ACs still need a home a successor can pick up: **file a follow-up
issue** for them (via the [`report`](../report/SKILL.md) skill) **or** point at
an existing sibling/child that already owns them, and **name that issue** in the PR body and your
Step-6 progress comment. This is how #2270 → #2415 and #2056 were reconciled *after* the fact —
do it up front. (A purely **mechanical** guard — e.g. warning when a `Fixes`-armed PR's touched
surface looks narrower than the issue's AC count — is **out of scope for this step**; noted as a
possible follow-up, not built here. The gate here is the coder-side prose discipline.)

This gate sits **upstream** of the `(b)` seam self-check below and is what makes it a *decision*:
`(b)` only verifies the seam is **well-formed** (a closing keyword **or** `Part of #N` — either
counts as "armed"), so on its own it waves a `Fixes #N` over-claim straight through. The
AC-completeness gate is what **decides which** of the two is correct, *before* `(b)` ever runs — it
does not replace `(b)`, it feeds it the right keyword. It leaves the `(c)` inverse guard untouched:
`Part of` is not a closing keyword, so a `Part of #N`-only PR still has a closing-keyword set of
exactly `{}`.

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

**Every PR body carries a `## Deviations` section — no exceptions, and `None.` only after you
walked the list.** You made judgment calls the issue did not specify: you narrowed a suggested
fix-shape, you left a sibling defect for a follow-up, you declined a reviewer's optional
suggestion, you pushed past a hook, you changed a test that asserted the defect. Those calls are
usually right, and until now nothing made you say them out loud — so they lived in your session
and died there, and the pipeline only learned about the ones a forthcoming run happened to
volunteer. The section, its four fields, the **seven classes** you check `None.` against, and the
gates' verdict rule are defined once in the contract's
[§DEV](../gh-issue-intake-formats.md) — read the classes there and compose against them; do not
re-derive them here. Two operational points that are yours, not the contract's:

- **Write it last, from the whole build, not from memory of the plan.** Re-read your own diff
  against the issue's `### What to build` + `### Acceptance criteria` and against any ADR you
  touched, then walk the seven classes. A deviation you noticed at hour one and forgot by PR-open
  is exactly the one that ships undisclosed.
- **`None.` is a claim you are accountable for.** A gate that finds a class-N deviation against a
  `None.` blocks on two counts (§DEV) — the deviation, and the false disclosure. An honest entry
  costs one sentence and is never itself a FAIL; the disposition line is where you say what you
  did about it (`no action needed` / `ADR #NNNN amends it` / `follow-up #M filed` /
  `for the reviewer to judge`).

```bash
# push CONFIRMED on the remote + #N proven mine, or nothing happened. stdout is `WT=` and `BRANCH=`.
bash ./.claude/.pipeline/skills/write-code/scripts/step5-push.sh <N> || exit 1
```

Then open the PR. The body is a **template you author**, so it stays here rather than in a script:
it carries `Fixes #N` and `## Deviations` ALWAYS, and adds the `Flag: <FLAG_KEY>` line **only** when
Step 4b fired (a dark ship behind a flag — newly-declared OR prior-PR); omit it for an ungated PR.

```bash
gh pr create \
  --base main \
  --title "<concise PR title>" \
  --body "$(cat <<'EOF'
<2–3 plain-language sentences: what changed and why, for a human skimming — the human-first summary that leads the body, before any technical detail>

Fixes #<N>
Flag: <FLAG_KEY>

## Deviations

<one entry per departure — class, Said / Did / Why / Disposition (§DEV) — or the literal `None.`>
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
bash ./.claude/.pipeline/skills/write-code/scripts/step5-seam-checks.sh <N> <PR> || exit 1   # stdout IS the five verdicts — silence is UNKNOWN, never "armed"
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
without the line silently drops the dark ship from ship-it's release queue (#1282). If (e) reports a
missing `## Deviations` section, patch the body the same way and re-run (e) — an absent section is a
gate FAIL by itself (§DEV), and the heading is the one part of the obligation a grep can hold you to.

### Attach before/after composition captures (UI diffs only) — the #2964 evidence-attach

When Step 4d fired (a UI diff), attach **before/after** composed-surface captures to the PR via the
evidence-attach capability (#2964, the `@kampus/fabrika-cli/capture`
`captureAndUpload`/`hostedUrls` leg): it takes a pre-edit baseline and post-edit result over the
local build, uploads them, and emits **SHA-bound** PR-attachment markdown bound to the pushed PR
head — the same convention `review-design`'s evidence path uses (ADR
[0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md)
governs where the bytes live). This hands the `review-design` reviewer the assembled before/after to
grade, not just a diff. Invoke the capability — don't re-implement upload — and bind it to the
pushed head SHA. For a non-UI diff Step 4d never fired, so there is nothing to attach and this is a
no-op.

---

## Step 6 — Log progress on the issue

Throughout the work, and at minimum when you open the PR, post a **progress comment**
on the issue you're working in the format-3 shape (Completed / Decisions / Gotchas /
Next — see [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §3). This
is the per-issue ledger for the next agent (a successor write-code run, or
`review-code`): what moved, what you decided and why, what bit, what's still open.

Compose the comment into a file under `$RUN_SCRATCH` — the per-run scratchpad namespace
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §SP) — never a fixed
`/tmp/write-code-progress.md`. Several coder lanes drain concurrently by design, so a fixed
leaf gets clobbered mid-run and reads back **the sibling lane's progress comment with no
error**, posting another issue's ledger onto yours (#3718, the same silent-clobber class as
#2038's `branch.txt`):

```bash
# compose the four-section comment at "$RUN_SCRATCH/progress.md" FIRST; the script re-derives the same
# session-keyed §SP path (it names it on stderr) and refuses to post an empty body.
bash ./.claude/.pipeline/skills/write-code/scripts/step6-progress-comment.sh <N> || exit 1
```

Assemble the comment from a temp file so multi-line markdown and backticks survive the
shell. Keep it scannable — bullets over paragraphs, omit a heading with nothing under
it. Record decisions at the point you make them, not retroactively.

> **Read the body into `$BODY` — NEVER `gh api -f body=@file`.** This applies to *every*
> comment this skill posts — the progress comment here, the Step 7 handoff, and the repair
> progress comment (Step R3). Unlike `curl`, `gh api -f`/`--raw-field` does **not** expand a
> leading `@`: `-f body=@/some/path` posts the literal string `@/some/path` — the intended body
> never renders *and* the local scratchpad path leaks into a public comment, which `leak-guard`
> (committed-files only) does not catch (PR #1567). Always assemble the text into `$BODY` first
> (`BODY="$(cat "$BODY_FILE")"`) and pass `-f body="$BODY"`, exactly as the snippets above do.
> See [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) → **Posting a comment body**.

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
# write the handoff to "$RUN_SCRATCH/handoff.md" FIRST; the script gates the post on owning the CHILD.
bash ./.claude/.pipeline/skills/write-code/scripts/step7-epic-handoff.sh <N> <EPIC> || exit 1
```

Distill, don't dump — the fine detail lives in the child's progress comments and PR.
**"Affects siblings" is the load-bearing field:** if finishing this child changed what
a later phase should do (a new module, a changed contract, a decision recorded), say
so — that's the context the `## Dependencies` graph routes along. If the child finished
in pure isolation with zero sibling impact, a one-line "Done" handoff is honest and
complete; don't manufacture cross-task context that isn't there.

A standalone (non-sub-issue) issue has no parent epic — skip this step.

---

## Step 8 — Release your claim, then hard-stop: hand the gate to a separate reviewer

This is the **terminus of initial-build mode**, and it is a hard stop. Once the PR is open
(Step 5), progress is logged (Step 6), and any epic handoff is posted (Step 7), do one last
thing and then stop.

### Release the claim — the last act of the run that held it

The claim you took in Step 3 protected *this* build. The build is over, so give it up:

```bash
bash ./.claude/.pipeline/skills/write-code/scripts/step8-claim-release.sh <N> || exit 1   # non-zero ⇒ the claim was NOT released
```

**Why this is mandatory, not tidy-up.** A claim that outlives its run never expires, and the
resolver returns the **earliest** authorized claim — so an unreleased marker owns the issue
permanently and **every later dispatch on it reads `lost`**: a repair round, a follow-up, a
stalled lane re-driven. That is not hypothetical — six lanes stalled at once behind claims whose
work was already complete, five of them unstamped and therefore unsupersedable by liveness
(#3780). Releasing here is what makes the re-dispatch of an already-worked issue a normal event
again.

**It frees the resolver, not the lane.** Release retracts the claim comment and **leaves the
assignee set**, so Step 1's picker still skips the issue while your PR is in review — a
re-dispatch can claim it, an idle picker cannot pick it up and re-implement it.

That backstop is only real because **Step 3 wrote layer one on the path you came in on** — the
claim winner sets it and you re-assert it idempotently, on the orchestrated path as much as the
direct one (§7
[Who writes layer one](../gh-issue-intake-formats.md#who-writes-layer-one-the-claim-winner-on-both-paths)).
It used to be asserted unconditionally while the orchestrated branch skipped the block that set it,
so on a delegated build this release freed the resolver over a gate that was never written and the
issue went back to fully unowned — `status:triaged`, unassigned, implementation already in review
(#4298). If you ever find yourself here without a gate, that is a **routed blocker**, not something
to reason past: do not release on an assumed backstop.

**Never route around a claim you cannot release.** Release retracts only markers carrying the
token you present; it cannot and must not evict another session's claim, whatever that claim's
age or liveness. If you find yourself wanting to clear someone else's marker, that is a routed
blocker for the operator (`pipeline-cli claim status --issue <N>` prints the inventory), never
your call — the contract's
[§7 Release / Staleness](../gh-issue-intake-formats.md#release-the-claim-ends-when-its-run-does)
owns both halves.

### Then stop — the gate is a separate reviewer's

**You are done — full stop.** Do **not** continue into the review gate on the PR you just opened:

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
[Repair mode](repair.md#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit), when a *separate*
reviewer has landed a FAIL on your PR — and even then you fix and resubmit, never review (Step R3).
If you were spawned with a wider "review-and-ship this through" instruction, the structural rule
here **wins** over it: open the PR, hand off, and stop — flag in your run ledger that the gate is
left to a separate reviewer.

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
Decision / Consequences) and follows the supersede rules for any ADR it replaces. There is
no committed index (ADR 0126) — the ADR PR is purely additive: it lands the new file (plus
the superseded file's status edit) on a branch and goes in via a PR the same as code (so
`review-code` can still gate it).

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
   bash ./.claude/.pipeline/skills/write-code/scripts/step3_5-claim-is-mine.sh "<N>" \
     || { echo "refusing to close #<N> — not my claim (Step 3.5)"; exit 1; }
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
- **Repair** (PR number — every step of it in [`repair.md`](repair.md)): resolve the PR's
  latest verdict per namespace (Step R1) and, if
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
(`review-code`, `review-doc`, or `review-skill` — §VERDICT), *you* are its consumer — [Repair mode](repair.md#repair-mode--consume-a-gate-fail-verdict-fix-and-resubmit)
reads the findings, fixes, and re-submits for an independent re-gate, while `ship-it` stays
the sole owner of PASS → merge. You also lean on two sibling skills inside type routing:
`/adr`
([`../adr/SKILL.md`](../adr/SKILL.md)) for `type:decision`, and [`report`](../report/SKILL.md) for an
investigation's actionable residue.
