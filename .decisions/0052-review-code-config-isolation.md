---
id: 0052
title: review-code Trusts the Base's Instructions, Exercises the Branch's Code
status: proposed
date: 2026-06-13
tags: [pipeline, skills, review-code, security, trust-boundary]
---

# 0052 — review-code Trusts the Base's Instructions, Exercises the Branch's Code

## Context

`review-code` is the fresh-eyes gate: it checks out a PR head and verifies it against
the linked issue's acceptance criteria (`review-code/SKILL.md` §Step 2 —
`git checkout <pr head ref>` / `gh pr checkout $PR`, then `pnpm typecheck`/`lint`/tests).
Checking out the head and running *in that working tree* means the reviewing agent loads
**the branch's own** instruction/config surfaces: `CLAUDE.md`, `.claude/skills/`, and
`.claude/settings.json` hooks. Every one of those is editable by the PR under review.

That is a trust inversion. The gate exists to judge the branch from the outside, yet it
reads its own operating instructions *from* the branch it is judging. A PR — malicious,
or merely a buggy harness edit — that touches `CLAUDE.md` or `.claude/**` can rewrite the
reviewer's instructions, suppress a check, or install a hook, and thereby influence both
the reviewing agent and (transitively, via the PASS marker it emits) the downstream
`ship-it` merge. The fresh-eyes property is only as strong as the instructions the
reviewer runs under being *trusted*, and today they are not.

phoenix is presently a solo, trusted repo, so live exploitation risk is low. But the
pipeline (`report` → `triage` → `plan-epic` → `review-plan` → `write-code` →
`review-code` → `ship-it`; ADRs [0046](0046-plan-epic-prd-grade-plans.md)–[0049](0049-pipeline-ships-code-not-itself.md))
is explicitly built to run autonomous and multi-agent. An unattended `review-code` that
trusts branch-controlled config is exactly the case this decision is about.

The external reference (openclaw/agent-skills `skills/autoreview/SKILL.md`, "Review engine
isolation") pins the reviewer's instruction/config sources to a trusted base, not the
branch head — running with flags equivalent to `--safe-mode --setting-sources user
--strict-mcp-config`.

**The real tension** the report named: the reviewer **needs the branch's *code*** to run
`pnpm typecheck`/`lint`/tests (you cannot verify behavior without exercising the actual
diff), but it **must not trust the branch's *instructions/config*** (`CLAUDE.md`,
`.claude/**`, hooks). Code and config arrive in the same checkout; the decision is how to
split them.

Two candidate mechanisms were on the table (report, non-binding):

- **(a) Flag the PR** — detect when a diff touches `CLAUDE.md` / `.claude/**` and surface
  that as a trust signal for extra scrutiny or a separate lane.
- **(b) Pin config to base** — run the gate with project instructions/config pinned to the
  *base* ref while still checking out the head's code to run tests.

## Decision

**`review-code` pins its instruction/config sources to the trusted base ref, while
exercising the branch head's code to run tests. The two are read from two different
places in a single run — code from the head, instructions from the base — and the
reviewing agent never loads the head's `CLAUDE.md`, `.claude/**`, or hooks.** This is
candidate (b), adopted as the structural mechanism.

Concretely, what changes for `review-code`'s checkout/run step (§Step 2):

1. **Resolve the trusted base.** The base is the PR's merge target (`base.ref`, normally
   `main`) at its current tip — the ref the operator already trusts. `review-code`'s
   instructions, skills, and hooks come from *that* tree.

2. **Exercise head code under base instructions.** The reviewer obtains the head's product
   code to run `pnpm typecheck`/`lint`/tests, but its own agent-config layer
   (project instructions, skills, settings/hooks, MCP) is sourced from the base, not the
   head. Equivalent to the reference's `--setting-sources` pinned to the trusted layer and
   `--strict-mcp-config` (no branch-introduced MCP servers): the head supplies *what is
   being tested*, the base supplies *the agent doing the testing*.

3. **The split is along the 0049 line.** ADR [0049](0049-pipeline-ships-code-not-itself.md)
   already drew the boundary the pipeline ships against: **product code lives under
   `apps/web/**` and `packages/**`; the harness lives under `.claude/**`, `.decisions/**`,
   `.patterns/**`.** review-code's trust split rides that exact seam — it exercises the
   head's product tree and ignores the head's harness tree as an *instruction* source.
   This is not a new taxonomy; it is 0049's boundary used for a second purpose (0049 used
   it to decide *who merges*; 0052 uses it to decide *whose instructions the reviewer
   trusts*).

4. **Make the invalid state unrepresentable, don't police it.** The reviewer must not be
   *able* to load head instructions, rather than being *trusted to remember* not to. A
   reviewer that reads its config from the base cannot be hijacked by a head edit to
   `CLAUDE.md` because that edit is never on its instruction path — the attack surface is
   removed, not guarded.

**Flagging (candidate a) is adopted only as a complementary signal, not the isolation
mechanism.** When a PR's diff touches `.claude/**`, `.decisions/**`, `.patterns/**`, or
the root `CLAUDE.md`, `review-code` surfaces that in its verdict as a harness-touching
PR. This dovetails with 0049: such a PR is *already* out of `ship-it`'s auto-merge scope
(harness changes merge manually), so the flag is the human-checkpoint trigger, not the
thing that keeps the reviewer safe.

### Why pin-to-base wins over flag-only

- **Flag-only does not isolate.** Detecting that a PR edits config and asking for "extra
  scrutiny" still runs the reviewer under the branch's instructions while it scrutinizes
  them — it trusts the config to evaluate the config. Worse, the surfaces aren't only
  edited *visibly*: a config change can subtly alter how the reviewer reads an *unrelated*
  product diff. Flagging is detection; it is not a boundary.
- **Pinning removes the trust, not just the surprise.** With config sourced from the base,
  a head edit to `CLAUDE.md`/`.claude/**` has no influence on the reviewing run by
  construction — there is no "did the reviewer notice?" failure mode left to police.
- **They are complementary, not competing.** Pinning is the structural floor (always on,
  every PR); flagging is the cheap signal that routes a harness-touching PR to the manual
  checkpoint 0049 already requires. Adopting both, with pinning as load-bearing, is
  strictly stronger than either alone — and costs nothing extra given 0049's existing
  manual-merge lane for harness changes.

A third option — **forbid checking out the head entirely and review from the diff only**
— was rejected: it would make behavior-verifying criteria (a test passes, typecheck is
clean) `UNVERIFIABLE`, gutting the gate's strongest evidence. The whole point is to *run*
the branch's code; the fix is to not let the branch's *instructions* ride along, not to
stop running its code.

## Consequences

- **Easier / safer:** the fresh-eyes gate becomes a *real* boundary — a PR cannot rewrite
  the instructions of the agent reviewing it, even autonomously and unattended. The PASS
  marker `ship-it` consumes is no longer derivable from branch-controlled config.
- **Trust seam is explicit and reuses 0049's:** "head = code under test, base =
  trusted reviewer" is one sentence, and it rides the `apps/web`+`packages` ÷ `.claude`+
  `.decisions`+`.patterns` line the pipeline already enforces — no new taxonomy to learn.
- **Harder / new cost:** `review-code`'s Step 2 must source agent config from the base
  rather than implicitly from the checked-out tree (the concrete runner mechanics — e.g.
  the equivalent of `--setting-sources`/`--strict-mcp-config`, or checking out only the
  head's product paths into a base-config workspace — are the follow-up implementation's
  to wire). A harness-touching PR carries an extra verdict flag.
- **Banned:** `review-code` loading the PR head's `CLAUDE.md`, `.claude/**`, or hooks as
  its own operating instructions; treating "flag the PR for extra scrutiny" as sufficient
  isolation on its own; skipping the head checkout of *product code* (that would forfeit
  behavior verification — head code is still exercised, only head *config* is distrusted).
- **Relationship:** scopes the trust model of `review-code` (review-code/SKILL.md §Step 2)
  and reuses ADR [0049](0049-pipeline-ships-code-not-itself.md)'s product÷harness boundary
  for a second purpose (whose instructions the reviewer trusts). Sibling to the Gap 1
  decision split from #183 (the forgeable PASS signal); together they harden the
  review-code → ship-it seam. This ADR is a harness change, so per
  [0049](0049-pipeline-ships-code-not-itself.md) it is **merged by hand**, and it is filed
  `proposed` — the operator ratifies it at that manual merge. The implementing change to
  `review-code`'s Step 2 is downstream of acceptance.
