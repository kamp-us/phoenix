---
id: 0467
title: A shell that runs outside a lane removes its own worktree when it ends
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0467 — A shell that runs outside a lane removes its own worktree when it ends

**What this decides:** an operator, a triager and any other agent that runs outside a lane deletes
its own checkout when it finishes. A checkout that still holds uncommitted or unpushed work is kept
and reported.

## Context

`fabrika lane worktree` records the tree a shell stands in, and `fabrika lane cleanup` removes the
recorded trees when the lane's run ends
([#10340](https://github.com/kamp-us/phoenix/issues/10340)). Both need a lane. Three kinds of shell
have none, or are skipped by the one they have:

- a triager, spawned once per issue by whoever drains the queue;
- an operator's own tree, which `lane cleanup` prints as `left` because no process removes the tree
  it runs in, and which the operate skill hands to "its own caller";
- a gate the operator spawns with no lane on a `verdict-owed` park.

Nothing removed those trees. ADR [0448](0448-worktree-create-hook-never-sweeps.md) had taken the
sweep out of the spawn hook the day before, so the pile grew again each time triage ran.
[#10389](https://github.com/kamp-us/phoenix/issues/10389) asked the founder to pick what removes
them.

The founder ruled on 2026-10-04, recorded in
[this comment on #10389](https://github.com/kamp-us/phoenix/issues/10389#issuecomment-5982686622).
The driver asked:

> When an operator or a triager finishes, should it remove its own worktree right then, the same way
> lanes now clean up their builders? My rec: yes (85%). It stops the pile at the source. Tradeoff: a
> tree with uncommitted or unpushed work is kept and reported, so a few odd ones will still need a
> look now and then.

The founder answered:

> yes, they should clean up their own worktree

The same comment closes with what that means:

> So: an operator removes its own worktree when its run ends, and so does a triager (and any other
> shell that runs outside a lane). The keep rule the lane cleanup already has stands: a tree holding
> uncommitted or unpushed work is kept and reported, not forced.

Under ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md), this record writes that ruling
down.

## Decision

**A shell that runs outside a lane removes its own worktree when it ends.**

That covers each case #10389 named:

- An operator removes its own worktree when its run ends.
- A triager removes its own worktree when it finishes.
- A gate spawned with no lane, and any other shell that runs outside a lane, does the same.

The keep rule `lane cleanup` already applies stands. A tree holding uncommitted or unpushed work is
kept and reported. Nothing forces a removal.

**How this sits with ADR 0386.** ADR
[0386](0386-worktree-accumulation-is-bounded-at-provisioning.md) refused a scheduled chore lane and
a hard cap on live trees. This record reopens neither. A shell removing its own tree as it ends is
not a schedule, and it refuses no spawn.

**How this sits with ADR 0448.** ADR 0448 left open where a sweep runs once the spawn hook stopped
running one. This record does not answer that. It names no sweep and no place for one. It removes
these trees at the source, one per shell, so the trees #10389 counted no longer wait on a sweep.
ADR 0448's own ruling, that the hook only provisions, is unchanged.

**What this does not decide.**

- How a process removes the tree it stands in. `lane cleanup` skips its caller's tree for that
  reason, and the ruling names the outcome, not the mechanism.
- What removes the tree of a shell that died before it could. ADR
  [0321](0321-dead-spawn-worktree-ownership.md) already gives that tree to the session holding the
  primary checkout, and this record leaves it there.
- When or where `build reap` runs, and its keep rule. Those stay with
  [#10342](https://github.com/kamp-us/phoenix/issues/10342).

**Binding constraints.**

- An operator, a triager and a lane-less gate each remove their own worktree as they end.
- A tree holding uncommitted or unpushed work is kept and reported, never forced off disk.

## Consequences

The operate skill's step 4 says a driver's own tree is left for "its own caller" to remove, and the
keep rule in `packages/fabrika-cli/src/lane/cleanup.ts` says the same. Under this record the
operator removes it. The triage skill and the triager shell say nothing about their tree today and
will have to.

None of that is built by this record. The work is filed as
[#10489](https://github.com/kamp-us/phoenix/issues/10489).

Until #10489 lands, these trees still pile up, and `build reap` run by hand is what clears them.

A tree that is kept still needs a person to look at it. The ruling accepts that cost.
