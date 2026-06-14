---
name: write-code
description: Pick the next actionable issue off kamp-us/phoenix and execute it end to end — claim it by self-assigning, implement on a branch, open a PR that closes it, log progress on the issue, and hand off to the parent epic. Trigger on "work the next issue", "pick up an issue", "implement issue #N", "run write-code", "do the next task", "/write-code", or whenever you're asked to turn triaged work into a PR. This is the execution stage of the issue-intake pipeline: it consumes `status:triaged` issues and produces PRs that `review-code` gates.
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

## Step 1 — Pick the next issue

The pick rule is deterministic. Among **open** issues that are `status:triaged` **and
unassigned**:

1. **Highest priority bucket first:** all `p0` before any `p1`, all `p1` before any
   `p2`.
2. **Oldest first within a bucket:** lowest issue number / earliest `created_at`.

Assigned issues are someone else's claim — **skip them**. `status:needs-triage`,
`status:needs-info`, and closed issues are not pickable (they haven't cleared triage).

List the candidate pool, priority bucket by priority bucket, stopping at the first
bucket that has any unassigned candidate:

```bash
# p0 first; only fall through to p1, then p2 if a bucket is empty of unassigned issues
for P in p0 p1 p2; do
  gh api "repos/kamp-us/phoenix/issues?state=open&labels=status:triaged,$P&sort=created&direction=asc&per_page=100" \
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
gh api repos/kamp-us/phoenix/issues/<N> --jq '.parent // "no parent (standalone)"'
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
gh api repos/kamp-us/phoenix/issues/$EPIC --jq '.body'
# the real child set + each child's state (the list endpoint is source of truth;
# sub_issues_summary undercounts under mixed closed/open children)
gh api "repos/kamp-us/phoenix/issues/$EPIC/sub_issues?per_page=100" \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
# the cross-task signal siblings left — read before assuming what's done
gh api "repos/kamp-us/phoenix/issues/$EPIC/comments?per_page=100" --jq '.[].body'
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

## Step 3 — Claim by self-assigning

Claiming is self-assignment — it's the lock that makes Step 1's "skip assigned issues"
rule work, so other write-code agents don't double-pick. Assign yourself **before** you
start work:

```bash
ME=$(gh api user --jq '.login')
gh api -X POST repos/kamp-us/phoenix/issues/<N>/assignees -f "assignees[]=$ME"
# confirm
gh api repos/kamp-us/phoenix/issues/<N> --jq '.assignee.login'
```

If the assign races and the issue already shows another assignee when you re-check,
back off — someone beat you to it. Re-run Step 1 and pick the next one.

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
git switch -c umut/<slug-for-issue-N> FETCH_HEAD
```

Use your git convention (a personal prefix like `umut/`) with a short kebab-case slug
naming the work. Read the issue's `### What to build` for scope and honor the `**TDD:**`
flag — `yes` means write the failing test first, then make it pass; `no` means
config/docs/scaffolding where test-first doesn't apply.

> **Non-isolated fallback.** For the rare invocation that isn't already in a worktree,
> spin one up rather than checking out `main`:
> `git worktree add -b umut/<slug-for-issue-N> ../wt origin/main`, then `cd ../wt`.

Ground the implementation in the codebase the way the repo expects: the ADRs in
`.decisions/` are the *why* and the binding decisions, the patterns in `.patterns/`
are *how the current code is shaped* — read the relevant ones before writing, and
follow them over intuition (per `CLAUDE.md`). Implement the issue's acceptance
criteria; they are the literal checklist `review-code` will verify, so build to make
every box checkable from the outside. Run `pnpm typecheck` / `pnpm lint` / the test
suite as the repo conventions require before you open the PR.

Commit per repo conventions. Don't push to or PR from `main`.

---

## Step 5 — Open a PR that closes the issue

Open the PR with **`Fixes #N` in the body** so merging auto-closes the issue (this is
the seam `review-code` relies on: pass → merge → `Fixes #N` closes it). Use the issue
number you're implementing.

```bash
git push -u origin umut/<slug-for-issue-N>
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
> after creation, patch via REST: `gh api -X PATCH repos/kamp-us/phoenix/pulls/<PR>
> -f body="…"`. Get the PR body right at `create` time and you won't need it.

Confirm the linkage landed — once `Fixes #N` is in the body, the issue's timeline
records a `cross-referenced` / `connected` event for the PR. Verify via REST:

```bash
gh api repos/kamp-us/phoenix/issues/<N>/timeline \
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
gh api repos/kamp-us/phoenix/issues/<N>/comments -f body="$BODY"
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
gh api repos/kamp-us/phoenix/issues/<EPIC>/comments -f body="$BODY"
```

Distill, don't dump — the fine detail lives in the child's progress comments and PR.
**"Affects siblings" is the load-bearing field:** if finishing this child changed what
a later phase should do (a new module, a changed contract, a decision recorded), say
so — that's the context the `## Dependencies` graph routes along. If the child finished
in pure isolation with zero sibling impact, a one-line "Done" handoff is honest and
complete; don't manufacture cross-task context that isn't there.

A standalone (non-sub-issue) issue has no parent epic — skip this step.

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
   gh api repos/kamp-us/phoenix/issues/<N>/comments -f body="$DIAGNOSIS"
   gh api -X PATCH repos/kamp-us/phoenix/issues/<N> -f state=closed -f state_reason=completed
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

A single invocation does one issue end to end: pick (Step 1, +Step 2 if a sub-issue),
claim (Step 3), then either implement→PR→progress→handoff (Steps 4–7) or the
type-routed path. Report back a short ledger: the issue picked (and why it was the
pick — bucket + age, or the eligibility derivation if it was a sub-issue), the branch
and PR opened (or the ADR/diagnosis for a decision/investigation), and a one-line
pointer to the progress comment. Don't narrate every REST call — the assignee, the
comments, and the PR are the durable record.

To sweep, re-invoke: each run re-derives the next pick from current state (including
sub-issue eligibility, which moves as blockers close), so the loop is stateless and
always picks the right next thing.

## Conventions

This skill is one of a suite (`report` → `triage` → `plan-epic` → `review-plan` →
**`write-code`** → `review-code` → `ship-it`) that turns GitHub issues into an agent-operable
pipeline. The shared label semantics and the body/comment/dependency formats live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). Your input is the
`status:triaged` issues that `triage` produced (standalone) or that `review-plan` flipped
from `status:planned` after gating a `plan-epic` ledger (epic children — ADR
[0047](../../.decisions/0047-review-plan-gate.md)); your output —
a claimed issue, a PR with `Fixes #N`, progress comments, and an epic handoff note — is
exactly what `review-code` reads to verify the work against its acceptance criteria
before merge. You also lean on two sibling skills inside type routing: `/adr`
(`.claude/skills/adr/`) for `type:decision`, and [`report`](../report/SKILL.md) for an
investigation's actionable residue.
