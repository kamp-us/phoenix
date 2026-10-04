---
id: 0456
title: A branch carrying an unmerged decision record reserves its ADR id before any pull request opens
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline, adr, decisions, concurrency]
---

# 0456 — A branch carrying an unmerged decision record reserves its ADR id before any pull request opens

**What this decides:** An ADR id counts as taken once a branch this clone can see carries a record
at that id, whether or not a pull request exists. ADR 0074 said the open pull request was the
reservation. That boundary moves to the branch ref.

## Context

[ADR 0074](0074-adr-number-claim-lock.md) allocates an ADR id from two sets: the records merged on
the base ref, and the ids open pull requests claim. Its Decision §1 says the number is "claimed
implicitly by opening the PR". A record committed and pushed with no pull request behind it was
outside both sets.

[#8229](https://github.com/kamp-us/phoenix/issues/8229) reports that gap biting. During the review
of [#8179](https://github.com/kamp-us/phoenix/issues/8179), `adr next` answered `0359` and listed only
`0355` in flight. Commit `c5271f4c` on the pushed branch `origin/can/tuval-streaming-replies` already
carried a record at `0359`, with no pull request. The record under review landed as `0360`. Nothing
in the verb prevented two records at `0359`.

The issue asked whether a pushed branch without a pull request reserves an id, replacing or extending
the 0074 boundary. Its report proposed the direction: the claim scan unions over pushed refs, so any
`origin/*` branch carrying a `.decisions/NNNN-*.md` that `main` lacks is a live claim regardless of
pull-request state.

The ruling is recorded at
[#8229, comment 5625049036](https://github.com/kamp-us/phoenix/issues/8229#issuecomment-5625049036).
It was written on 2026-09-10 by a session acting on the founder's behalf, under his standing ruling
that pipeline mechanics are the driver's to decide:

> This is pipeline mechanics, which ADR 0078 puts on engineering and #8807 puts on the driver. The
> fix direction is obvious and the near-collision is already documented on the issue.

This ADR transcribes that ruling
([ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md)). The engineering lead it leans on is
[ADR 0078](0078-product-driven-decisions-by-default.md).

The ruling names the direction and nothing finer. It does not say which refs count, what happens to
an abandoned branch, or what an unreadable ref does. Between the ruling and this record, the
mechanism landed on its own account: [#8901](https://github.com/kamp-us/phoenix/issues/8901)
reported two epic children each minting `0373`, and
[#9381](https://github.com/kamp-us/phoenix/pull/9381) fixed it by adding a third set to the
allocation. Where this record is more specific than the ruling, it describes that shipped mechanism.
It does not choose anything the ruling or the source has not.

## Decision

**A branch ref that carries a decision record the base ref lacks reserves that record's id, with or
without a pull request.**

The reservation boundary of ADR 0074 moves from "the pull request is open" to "the record is
committed on a branch this clone can see". The allocation is the maximum over three sets, plus one:
the merged records on the fetched base ref, the ids open pull requests claim, and the ids branch
refs claim.

**Which refs count.** Every local branch and every remote-tracking ref of the allocating clone,
read in one walk of the commits not reachable from the base commit. A record path under the decision
directory that such a commit touches is a claim. Worktrees of one clone share local branches, so a
sibling lane's unpushed commit counts at once. A branch pushed from another clone counts once this
clone has fetched it.

**Abandoned and deleted branches.** A claim lives as long as its ref does. There is no age cutoff,
so an abandoned branch keeps its id reserved until someone deletes the branch. That direction costs
a skipped number and never a reused one, because the allocation is the maximum plus one and does not
fill gaps. A deleted local branch stops counting at once. A branch deleted on origin stops counting
when the clone prunes its remote-tracking ref. A branch that was squash-merged still counts, and
harmlessly: its id is on the base ref already, so it cannot raise the maximum.

**Unreadable refs.** A branch walk that fails makes the set UNKNOWN, and the verb refuses on exit
`23` without answering. It never reads a failed walk as "nothing claimed". A path under the decision
directory that is not a record name is skipped and does not refuse, because the branch set is a set
of claims and not a corpus.

**`adr next` and `adr mint` apply one policy.** Both call the same allocation read, so they count
the same three sets and refuse on the same failures. `adr resolve` is not part of this: it reads the
base ref and the open pull requests only, so its `absent` does not mean no branch holds the id.

**Binding constraints.**

- No verb or document may describe this allocation as atomic or globally unique. It is still
  detect-and-serialize, as ADR 0074 §2 states.
- A set the allocation could not read in full is a refusal, never an empty set.

## What this amends

**ADR [0074](0074-adr-number-claim-lock.md), Decision §1.** 0074 names two sets and says the open
pull request is the reservation. The allocation now has three sets, and the committed record on a
visible branch is the reservation. The open pull request still reserves, as the second set. The rest
of 0074 stands: the choice of a reservation over merge-time allocation or a non-sequential id, the
fail-closed read, and the residual stated in §2.

## Consequences

The pushed-branch case the issue reported is counted, provided the allocating clone has fetched that
branch. Two lanes in one clone no longer collide between commit and pull request.

The residual window is narrower and still open. Three cases stay outside every set:

- Two lanes that allocate in the same moment, before either commits.
- A record committed in another clone and not yet pushed.
- A branch pushed from another clone that this clone has not fetched.

The duplicate-id check at merge time remains the backstop for all three.

The third case is the one closest to the `0359` report, and the mechanism does not close it by
itself. The verbs fetch the base ref only, so the remote-tracking refs are as fresh as the clone's
last fetch, and nothing prunes a ref whose branch is gone from origin. Whether the verbs should
fetch and prune before the walk is not ruled here. It is filed as
[#10445](https://github.com/kamp-us/phoenix/issues/10445).

Implementation work that follows from this record:

- Done: the third set, shared by `adr next` and `adr mint`
  ([#9381](https://github.com/kamp-us/phoenix/pull/9381)).
- Open: remote-tracking freshness and pruning
  ([#10445](https://github.com/kamp-us/phoenix/issues/10445)).
- Open: `adr mint --help` still describes a two-set union
  ([#9385](https://github.com/kamp-us/phoenix/issues/9385)).

An abandoned branch costs one skipped id for as long as it exists. Ids are cheap and a reused id is
not, so no cleanup step is added.

## Records

no vocabulary impact
