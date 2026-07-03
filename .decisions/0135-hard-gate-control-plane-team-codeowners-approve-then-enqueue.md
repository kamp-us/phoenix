---
id: 0135
title: "Hard-gate control-plane changes — the @kamp-us/control-plane team makes require_code_owner_review satisfiable; CODEOWNERS maps §CP paths → the team; ship-it ENQUEUES a §CP PR once a team member APPROVES it at the current head (amends 0053's merge model from human-hand-merge to approve-then-pipeline-enqueue)"
status: accepted
date: 2026-07-03
tags: [pipeline, ship-it, security, control-plane, governance, github]
---

# 0135 — Hard-gate the control plane: a control-plane team + CODEOWNERS + ship-it enqueues §CP on team approval

## Context

The control-plane boundary (ADRs [0053](0053-control-plane-boundary.md) / [0065](0065-gate-critical-skills-are-blocking.md);
the canonical §CP set in [`gh-issue-intake-formats.md §CP`](../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md))
is a **security** boundary: the pipeline must not auto-merge a weakening of its own guardrails —
the skills, hooks, CODEOWNERS, and CI that *perform* the merge. ADR
[0071](0071-enforce-control-plane-at-github.md) already resolved to make that boundary binding at
the GitHub platform, and named the exact mechanism this ADR now enacts.

**The gap: §CP is enforced by convention only.** Today `ship-it`'s Step 0 *refuses* to merge a §CP
PR and a human hand-merges it — but GitHub itself enforces nothing. The `main` ruleset (id
`17377992`, `enforcement: active`) sets **`required_approving_review_count: 0`** and
**`require_code_owner_review: false`**, and the checked-in `.github/CODEOWNERS` (added under 0071)
mapped the §CP paths to `@usirin` but is **inert** because no ruleset rule consumes it. So the
boundary rests entirely on `ship-it`'s self-restraint plus operator discipline: any `write+` actor
running `gh pr merge --auto` on a green §CP PR would merge it, and **GitHub would not stop them** —
a rogue or buggy actor, a mistaken command, or a compromised token defeats the boundary. This is
the honor-system gap #382 named and 0071 set out to close.

**Why the single-operator model couldn't just turn on required review.** 0071 wanted
`require_code_owner_review: true`, but under GitHub's review rules **an author cannot approve their
own pull request** — the reviewers endpoint refuses to request the author, and a self-submitted
review does not count as an approval (this is the same constraint that makes `ship-it` consume a
*marker comment* rather than a native approval, ADRs [0048](0048-ship-it-merge-actor.md) /
[0055](0055-acl-sourced-review-authz.md)). With a **single** control-plane owner (`@usirin`), a
required code-owner review would be **unsatisfiable** on that operator's own §CP PRs — the operator
is both author and sole code owner, and GitHub blocks the self-approval — so 0071 could only
*record* the target config, not enact it. 0071 anticipated the fix explicitly: the owner may be
"a GitHub **team whose membership is humans only** … when a second human operator is added."

## Decision

Enact 0071's anticipated fix and **loosen 0053's merge model** so the human owns the *judgment*
(the approval) while the pipeline owns the *mechanics* (the enqueue).

### 1. The `@kamp-us/control-plane` team makes `require_code_owner_review` satisfiable

Create a GitHub team **`@kamp-us/control-plane`** whose members are the two human operators
(`usirin` + `cansirin`), both with push access to the repo. A two-person team is what makes
required code-owner review **satisfiable** on a §CP PR: because GitHub blocks self-approval, the
author's own approval never counts — but the **other** team member can approve. One operator can no
longer land a §CP change alone; every §CP change now carries a second human's approval. The team is
**humans-only** — never an agent/bot collaborator — so the ADR-0055 agent-inclusive verdict ACL
cannot satisfy this gate (an agent approval would defeat the human-judgment property). This is the
0071 §2 requirement, now realized.

### 2. CODEOWNERS maps the §CP paths → the team

`.github/CODEOWNERS` repoints every §CP path-line from `@usirin` to `@kamp-us/control-plane` — the
same paths (the 0053/0065/0100/0103 blocking set: `/.claude/`, `/.github/`, the gate-critical
skills, `gh-issue-intake-formats.md`, the pipeline hooks + `hooks.json`, `/packages/ci-required/`,
`/packages/pipeline-cli/`), new owner. The file stays **inert** until the ruleset consumes it (§3).

### 3. The `main` ruleset flip makes the gate a GitHub hard-block (a separate Phase-3 step)

After this PR merges, a human sets on the `main` ruleset's `pull_request` rule:

- **`require_code_owner_review: true`** — GitHub then **hard-blocks** merging any PR that touches a
  CODEOWNERS-owned (§CP) path until a code owner (a `@kamp-us/control-plane` member) has approved
  it. This is the platform backstop 0071 §2 specified; it replaces convention with enforcement.
- **`dismiss_stale_reviews_on_push: true`** — a push *after* an approval dismisses that approval, so
  a post-approval head change **re-requires** a fresh approval. This is SHA-freshness for the human
  gate, mirroring ADR [0058](0058-sha-bound-verdict-contract.md)'s SHA-binding for machine verdicts:
  an approval attests the exact tree it approved, and a moved head is un-approved.

This ADR **records the desired enforcement**; the exact ruleset field values are **set and verified
live at the Phase-3 flip**, not asserted here (per the CLAUDE.md "ground platform claims in source,
not intuition" discipline — the current live ruleset is honor-system as described in Context, and
the target values become fact only once a human applies and confirms them). The pipeline does not
change its own GitHub enforcement — enacting the ruleset is a human governance act, consistent with
the very boundary it makes binding (0071 §3).

### 4. ship-it ENQUEUES a §CP PR on a current-head team approval (this AMENDS 0053's merge model)

0053 §4.1 made §CP "the pipeline never merges it; a human merges it by hand." **0135 amends that
merge model.** §CP is no longer *pipeline-never-merges*; it is **approve-then-pipeline-enqueue**:

- `ship-it`'s §CP **detection** is unchanged — the `CONTROL_PLANE_RE` §CP set, resolved live from
  `origin/main` and fail-closed on an unreadable boundary (0053 §4, §CP contract). Only the
  **action** on a detected §CP PR changes.
- On a §CP PR, `ship-it` checks for an **APPROVED** GitHub review authored by a
  `@kamp-us/control-plane` team member and **bound to the PR's current head** — the review's
  `commit_id` (the commit the review was submitted against, per the GitHub REST reviews resource)
  must equal the PR head SHA. A stale approval on a superseded head **does not count**, mirroring
  0058's SHA-staleness rule for machine verdicts. Reviews and team membership are resolved via
  `gh api` REST (`GET /repos/{repo}/pulls/{n}/reviews`, `GET /orgs/{org}/teams/{team}/members` /
  `GET /orgs/{org}/teams/{team}/memberships/{user}`), never GraphQL (the org's Projects-classic
  integration breaks GraphQL PR queries).
  - **Current-head team approval present** AND all existing gates green (the matching-gate SHA-bound
    PASS, CI green, the run-evidence bundle) → **ENQUEUE** exactly like a non-§CP PR
    (`gh pr merge --squash --auto`; QUEUED → auto-merges on green, the queue owns the final async
    merge per ADR [0132](0132-merge-queue-for-base-freshness.md), which §CP PRs now enter too).
  - **No current-head team approval** → **STOP** at `awaiting control-plane approval` (do **not**
    enqueue); report that a `@kamp-us/control-plane` member must approve the PR at its current head.
    This **replaces** the old blanket refuse.

Every other `ship-it` guard is **unchanged**: the SHA-bound gate verdict (0058), CI-green (0061),
the run-evidence bundle (0054), and single-merge-authority (0048). §CP now carries **one additional**
gate — the current-head team approval — layered *on top of* the same machine gates a non-§CP PR
clears.

### The tradeoff — a deliberate two-person control on the control plane

Because GitHub blocks self-approval, **a team member cannot approve their own §CP PR** — a §CP
change authored by `usirin` needs `cansirin`'s approval, and vice versa. This is not a limitation to
route around; it is the point. The control plane — the machinery that performs every merge — now
requires *two* humans to change, a deliberate two-person control that a single rogue/buggy/compromised
actor cannot satisfy alone. The cost is real (a §CP PR can no longer be landed solo) and accepted.

## Consequences

- **The boundary gains its platform backstop.** After the Phase-3 flip, GitHub hard-blocks any §CP
  merge without a current-head `@kamp-us/control-plane` approval — the honor-system gap (#382, this
  ADR's Context) is closed by the platform, not by `ship-it`'s self-restraint alone. `ship-it`'s
  §CP check becomes defense-in-depth *over* a platform gate.
- **The autonomous non-§CP lane is unchanged.** A PR that touches no CODEOWNERS path triggers no
  code-owner review (`require_code_owner_review` is vacuously satisfied) and ships on its machine
  gates exactly as before — the `write-code → review-* → ship-it` loop is untouched (0071 §2).
- **§CP shifts from human-hand-merge to approve-then-enqueue.** Human judgment enters via the
  approval; pipeline mechanics via the enqueue. A §CP PR no longer waits for a human to run the
  merge — it waits for a human to *approve*, then the same queue that ships product code lands it.
- **§CP now requires two humans.** Self-approval is blocked, so every §CP change carries a second
  operator's approval — a deliberate two-person control, at the cost of solo §CP landings.
- **SHA-freshness for the human gate.** `dismiss_stale_reviews_on_push` (platform) + `ship-it`'s
  `commit_id == head` check (skill) both require the approval to be bound to the current head; a
  post-approval push re-requires approval. Mirrors 0058 for machine verdicts.
- **This PR is itself §CP** (it touches `.github/CODEOWNERS`, the gate-critical `ship-it` skill, and
  `.claude/**`). It merges under the **current** model — a human hand-merge — because the new
  hard-gate is not live until the Phase-3 ruleset flip *after* this lands. `ship-it`'s new
  approve-then-enqueue action does not govern its own enabling PR.
- **Banned:** a §CP CODEOWNERS owner that is an agent/bot or an agent-inclusive team (an ADR-0055
  agent approval would defeat the human-judgment property); treating a stale-head approval as
  satisfying the §CP gate; enqueuing a §CP PR with no current-head team approval; enacting the
  ruleset by click-ops UI edit instead of the recorded config (0071 §3).
- **Relationship — amends [0053](0053-control-plane-boundary.md).** 0053's boundary *definition*
  (the §CP path set) is **unchanged**; its *enforcement* moves convention → GitHub-hard, and its
  *merge model* moves human-hand-merge → approve-then-pipeline-enqueue. 0053's body is immutable —
  it is not edited; it is **amended-by-0135**. **Realizes [0071](0071-enforce-control-plane-at-github.md)**
  §2's anticipated humans-only team owner (the single-operator constraint 0071 hit is resolved by the
  two-person `@kamp-us/control-plane` team). Extends [0065](0065-gate-critical-skills-are-blocking.md)
  (the gate-critical set the §CP paths cover). Mirrors [0058](0058-sha-bound-verdict-contract.md)
  (SHA-bound verdicts) for the human approval. Preserves [0048](0048-ship-it-merge-actor.md)
  (single-merge-authority — `ship-it` still owns the enqueue). §CP PRs now enter the
  [0132](0132-merge-queue-for-base-freshness.md) merge queue like every other PR.
