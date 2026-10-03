---
id: 0449
title: build reap removes a tree a ref covers, and any tree whose branch is merged or closed
status: accepted
date: 2026-10-03
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0449 — build reap removes a tree a ref covers, and any tree whose branch is merged or closed

**What this decides:** `fabrika build reap` removes a clean worktree whenever a branch,
remote-tracking ref or tag reaches every commit it holds, and removes any worktree whose branch or
pull request is merged or closed, uncommitted edits included. Under `--execute` it removes each tree
as it classifies it, so a bounded pass stops reading once its removals are spent.

## Context

ADR [0386](0386-worktree-accumulation-is-bounded-at-provisioning.md) left `build reap` with one
removal proof: the trunk already carries the tree's HEAD. Its "What does not change" section says
nothing makes a dirty tree removable.

A dry run on the operator clone on 2026-10-03 scanned 512 trees and kept 486. It kept 355 as "it
carries work `origin/main` does not", and a branch, remote-tracking ref or tag already reached the
HEAD of 351 of those. Removing a worktree takes the checkout and leaves every ref, so those 351
trees held nothing a removal could lose. Another 34 were kept for uncommitted paths. The data volume
read 92% used that day, and each tree carries its own installed dependencies.

The founder ruled twice on [#10342](https://github.com/kamp-us/phoenix/issues/10342) that day.

[First ruling](https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973709319), asked
whether the sweep may delete a worktree when a branch already holds all of its commits:

> "yes, if a branch is already merged or closed, just nuke it."

[Second ruling](https://github.com/kamp-us/phoenix/issues/10342#issuecomment-5973715141), asked
whether that also covers a worktree that still has uncommitted edits, and told the delete cannot be
undone:

> "yes, nuke them too why would we keep them in?"

Under ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md), this record writes those two
rulings down. The scan order is an engineering choice and is recorded with them because it changes
what the verb prints.

## Decision

**A removal can lose two things only: a path nobody committed, and a commit no ref reaches. `build
reap` keeps a tree for those, and only while its branch is not proven finished.**

### The rule, in order

The first arm that answers seats the tree.

1. **Kept, as before.** The run's own tree, a tree inside the one-day quiet window, a locked tree,
   and a tree whose directory or liveness could not be read. The quiet window is what protects a
   seat that never commits.
2. **Pruned, as before.** A registration whose directory is gone.
3. **Removed, as before.** A clean tree the trunk already carries: licenses `ancestor`, `squashed`
   and `no-change`.
4. **Removed, new.** A clean tree whose every commit a branch, remote-tracking ref or tag reaches,
   whether or not the trunk carries its HEAD. License `ref-reached`. It needs no board read.
5. **Removed, new.** A tree whose branch or pull request is proven merged or closed, whatever it
   holds: uncommitted paths, or commits no ref reaches. License `branch-ended`.
6. **Kept.** Everything else, and the report names what the tree holds and what was not proven.

Arm 5 never overrides arm 1. A live, locked or unreadable tree stays whatever the board says.

### What "proven merged or closed" reads

The board is asked about the branch the tree holds, in this order:

- An **open** pull request with that branch as its head keeps the tree, however many closed ones sit
  beside it.
- With none open, a **merged** pull request ends the branch, and so does one **closed unmerged**.
- With no pull request on the branch, the issue or pull request its name carries a number for
  decides: `build/<n>-…`, `build/pr-<n>-…` and `epic/<n>`. Closed ends the branch. Open keeps the
  tree.

Everything short of an answer keeps the tree: a read that failed, a branch that names no issue or
pull request, and a tree holding no branch. A detached tree is never matched to a pull request by
its commit. A commit on the trunk belongs to a merged pull request, so that lookup would read every
long-lived detached checkout as finished, and the founder's own desk is one.

An unreadable `git status` or ref count keeps the tree before the board is asked.

### How a dirty tree goes

`git worktree remove` refuses a tree with uncommitted paths, and `--force` stays banned on every
path. A tree arm 5 releases while it holds uncommitted paths has them committed onto its own branch
first, then is removed plainly. This is ADR [0321](0321-dead-spawn-worktree-ownership.md)'s salvage,
the route `build retire` already takes. If the salvage commit fails the tree is left standing and
the run reports it.

A tree holding no branch never takes this route: with no branch there is nothing to ask the board,
so it is kept at arm 6.

### The scan order

A dry run seats the whole population and prints every verdict, as before.

Under `--execute` trees are seated one at a time in registration order, and a tree seated `Remove`
is removed before the next one is read. `--limit` bounds the removals attempted. The scan stops when
that bound is spent, and the trees past it are not read and are reported as a count, `unscanned`.
The `unattempted` list is gone: the verb no longer knows which unread trees were removable.

Each read is paid only by the trees the arms before it left open. The board is read only for a tree
arms 3 and 4 left open, one holding uncommitted paths or unreached commits.

### What this amends

**ADR 0386, "What does not change".** That section says anything short of positive proof that a tree
carries nothing is a KEEP, and that nothing makes a dirty tree removable. Both sentences now have
one exception: a tree whose branch is proven merged or closed goes whatever it holds. The rest of
the section stands. `--force` is banned on every path, a read that failed proves nothing, and a
locked or unreadable tree is kept.

**ADR [0323](0323-board-licensed-worktree-retirement.md), by difference and not by amendment.** For
`build retire`, a pull request closed unmerged is not terminal, because it can be reopened onto the
same head. For `build reap` it is finished. The rulings are about the sweep, so `build retire`'s
licenses are unchanged. The cost of the difference is small: the sweep takes the checkout and leaves
the branch, with any uncommitted paths committed onto it, so a reopened pull request still has its
head.

**ADR [0342](0342-unclaimed-lane-worktree-retirement.md), untouched.** It borrowed the sweep's old
polarity for `build retire`'s unclaimed-lane arm. That arm keeps its rule.

## Consequences

Trees that only a lane branch reaches are removable. On the operator clone those were 351 of the 355
kept as unlanded.

Uncommitted edits in a tree on a finished branch are no longer a reason to keep it. They survive as
a `wip: salvage` commit on the local branch, which nothing pushes.

Arm 5 reaches a tree with commits no ref reaches only in the predicate. A tree standing on a branch
always has its commits reached by that branch, and a detached tree has no branch to ask about. So in
a real sweep, the 4 trees the operator clone held with unreached commits stay kept unless the trunk
carries what they add. Releasing them needs a way to tie a detached tree to a pull request without
the desk hazard above, and that is not decided here.

A bounded `--execute` pass costs what it takes to find its removals. It always starts at the head of
the registration list, so trees kept there are read again on every pass.

Each undecided tree on a branch costs one or two board reads.

`build reap`'s JSON gains `unscanned` and `removed[].salvaged`, and loses `unattempted`.

## Measured on the operator clone, 2026-10-03

Dry runs only; nothing was removed. The pile was being cleared by hand that day, so the 512-tree
snapshot in Context no longer reproduces. One dry run of the new rule over what was left:

| | trees |
|---|---|
| population | 436 |
| removable | 260, all `ref-reached` (257 detached) |
| stale | 14 |
| kept, inside the quiet window | 125 |
| kept, uncommitted paths on a detached tree | 31 |
| kept, uncommitted paths on a branch naming no issue | 1 |
| kept, commits no ref reaches that the trunk does not carry | 4 |
| kept, the run's own tree | 1 |

Under the old rule every one of those 260 is a clean tree the trunk does not carry, so it is kept.
The class the old report called "carries work `origin/main` does not" falls to the 4 trees no ref
reaches.

The full dry run took 4m14s with the load average between 17 and 32. In that registration order the
fourth removable tree is the 10th of the population, and 6 of those 10 pay for git reads, against
296 for the whole scan. A timed `--execute --limit 4` pass was not run: removing trees on that clone
was out of this change's hands.

This record does not decide when the sweep runs. ADR
[0448](0448-worktree-create-hook-never-sweeps.md) took it out of the worktree-create hook, and
[#10340](https://github.com/kamp-us/phoenix/issues/10340) carries the end-of-lane cleanup.
