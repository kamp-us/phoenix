---
id: 0324
title: A verb retires a superseded epic-child lane branch by renaming it out of build/, never deleting it
status: accepted
date: 2026-08-21
tags: [fabrika, pipeline-hardening, lane, epic]
---

# 0324 — A verb retires a superseded epic-child lane branch by renaming it out of build/, never deleting it

**What this decides:** when two local branches both carry one epic child's commits and `lane prove`
refuses because it cannot tell which range the lane built, a `fabrika` verb clears it — by renaming
the superseded branch out of the `build/` namespace, so nothing is destroyed and the branch stays
recoverable. An operator runbook was rejected; so was a delete-form verb.

## Context

An epic child opens no pull request (ADR [0285](0285-epic-machine-ends-in-review.md)), so the artifact
its `DONE` stands on is the commits themselves, located by walking the local branches. Two branches
carrying one child's commits makes that range underivable, and the code says so rather than guessing:
`traceRange` in [`packages/fabrika-cli/src/lane/prove.ts`](../packages/fabrika-cli/src/lane/prove.ts)
returns `{_tag: "Many"}` when more than one branch carries commits naming the issue, and `locateRange`
in [`packages/fabrika-cli/src/lane/range.ts`](../packages/fabrika-cli/src/lane/range.ts) maps that to
an `Ambiguous` outcome — *"which range this lane built is not derivable here"* — which `lane prove`
seats as a refusal. Picking the first branch would record a `DONE` against a range nobody reviewed,
so the refusal is right.

Nothing in the loop could clear it. `build branch --resume-lane` already prints the remedy —
*"retire the superseded branches, then re-run"*
([`branch-verb.ts`](../packages/fabrika-cli/src/build/branch-verb.ts)) — and no verb performs it. The
moves an agent could reach for by hand are both wrong: `git branch -D` refuses a branch another
worktree has checked out, and `git branch -m` does not refuse there at all — it renames and silently
retargets that worktree's `HEAD` (ADR [0323](0323-board-licensed-worktree-retirement.md), measured
against git 2.40.1 on #6386). A worktree-isolated agent may not prune another tree either. So the
lane's ledger append stayed unprovable until a human intervened, with no written procedure for the
human either. #6296 and #6298 both reached that state.

The rulings around this one cover prevention and the worktree, and leave the recovery open.
[#6379](https://github.com/kamp-us/phoenix/issues/6379) and
[#6334](https://github.com/kamp-us/phoenix/issues/6334) are **prevention**: an epic child sent back
by an integrate-`FAIL` resumes the reviewed branch instead of cutting a second one, and a repair
round reuses its round-1 identity — so the second branch is never cut in the first place. ADR
[0323](0323-board-licensed-worktree-retirement.md)'s `build retire` takes the *worktree* back, not
the branch, so a tree that already holds two carrying branches is still ambiguous after it runs. This
ADR is the recovery complement: what to do for a tree already in the two-branch state, which
prevention by construction cannot reach.

Recorded as transcription under ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md); the
choice is the founder's, ruled on
[#6389](https://github.com/kamp-us/phoenix/issues/6389#issuecomment-5346348344) (2026-08-19).

## Decision

**A `fabrika` verb retires a superseded epic-child lane branch, and it retires it by renaming the
branch out of the `build/` namespace — never by deleting it.**

Renaming is what makes the capability safe to hand an agent. After the rename the branch still
exists, still carries every commit, and is still reachable by name; what changes is only that
`traceRange` no longer counts it as a `build/<issue>-<slug>-<nonce>` candidate, so exactly one
carrying branch is left and `lane prove` locates the range instead of refusing. A mistaken retirement
costs a rename back, not the work.

The policy question this ticket existed to answer — may an agent ever retire another lane's branch —
is answered **yes, non-destructively only**. A delete-form verb was rejected outright: it would hand
every build lane a destructive cross-lane capability, and the blast radius of a wrong guess there is
another lane's unpushed work, which a child's branch is the only copy of. A human-only operator
runbook was rejected too, as inconsistent with the verb-over-hand-runbook direction already set on
[#6374](https://github.com/kamp-us/phoenix/issues/6374) and #6334: a procedure only a person can run
turns every occurrence into a park that spends a human.

**Binding constraints.**

- The retirement is a rename out of `build/`. No path of this verb deletes a branch.
- The verb is agent-runnable — a worktree-isolated build lane may run it against a branch its own
  lane did not cut.
- It is recovery, not prevention. It does not relax #6379's or #6334's rulings, and a lane that can
  resume its prior branch resumes it rather than cutting a second one and retiring the first.
- The rename proves no worktree holds the branch before it runs. `git branch -m` does not refuse a
  held branch, so skipping that proof is destructive in the one way the ruling bans — it retargets
  another lane's live `HEAD`. Clearing that hold is ADR 0323's `build retire`, not this verb.

This ADR records the direction and ships no code; the verb's own build ticket is
[#6889](https://github.com/kamp-us/phoenix/issues/6889).

## Consequences

A tree already deadlocked has a move an agent can take, so the two-branch state stops being a park
that costs a person. The cost is a growing set of renamed-aside branches nobody prunes — bounded and
local (a child's branch is never pushed), and deliberately preferred over a delete that cannot be
undone.

`lane prove`'s `Ambiguous` refusal keeps its meaning: it still says the range is underivable, and
still refuses. What changes is that the refusal now names an act rather than a wait.

## Records

no vocabulary impact
