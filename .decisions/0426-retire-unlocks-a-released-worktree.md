---
id: 0426
title: build retire unlocks a tree it has released and removes it plainly, never with --force
status: accepted
date: 2026-09-27
tags: [fabrika, pipeline-hardening, worktree]
---

# 0426 — build retire unlocks a tree it has released and removes it plainly, never with --force

**What this decides:** when `build retire` has already licensed a worktree's removal, it may run
`git worktree unlock` and then a plain `git worktree remove` on it. That pair is not the `--force`
ADR 0321 bans, so a locked tree no longer needs a human.

## Context

ADR [0321](0321-dead-spawn-worktree-ownership.md) bans `git worktree remove --force` on every path,
for every tree. ADR [0323](0323-board-licensed-worktree-retirement.md) built `build retire` on that
ban. It salvages a released tree, then runs a plain remove.

The agent harness locks most trees it registers. git refuses a plain remove on a locked tree however
clean it is. So `build retire` cleared the unlocked minority and reported every locked tree as an
incident. That left a human doing the cleanup #6610 set out to remove. 0323 named the gap and left it
open: "A locked worktree still needs a human, because 0321's `--force` ban outranks the convenience.
[#6881](https://github.com/kamp-us/phoenix/issues/6881) carries that gap to the founder."

The founder answered on #6881:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/6881#issuecomment-5519864099). His
answer was **yes** to "Is `git worktree unlock` followed by a plain `git worktree remove` allowed for
a tree `build retire` has proven dead?" The lens he set for the batch: reduce toil, pick the cheapest
option, add no new gate or token unless a failure actually recurred. Under ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md), this record writes that ruling down.

## Decision

**A tree `build retire` has released may be unlocked and then removed with a plain
`git worktree remove`, and that pair is outside ADR 0321's `--force` ban.**

0321's ban aims at content: a remove that refuses after salvage means something in the tree is
unaccounted for. A harness lock is not content. It carries no per-tree judgment, and releasing it
spends none. The refusal the ban protects still stands after the unlock, because a plain remove still
refuses a dirty tree. `packages/fabrika-cli/src/build/locked-removal.git.test.ts` measures all three
facts against real git: a clean locked tree refuses, unlock then plain remove succeeds, and an
unlocked dirty tree still refuses.

The proof that licenses the unlock is the one `build retire` already makes. `classify` or
`seatResidue` in `packages/fabrika-cli/src/build/retire.ts` must have returned a `Release` verdict
under one of the three licenses (`ticket-terminal`, `session-adopted`, `lane-unclaimed`).
`removeWorktree` takes that verdict to unlock, so the unlock cannot run without one.

**Binding constraints.**

- The unlock runs only on the `build retire` path, after a `Release` verdict. A held tree is never
  unlocked, and no other caller of `removeWorktree` gains an unlock. `build reap` still keeps a locked
  tree that is present on disk. ADR
  [0386](0386-worktree-accumulation-is-bounded-at-provisioning.md)'s rule that absence is the only
  license to unlock is that sweep's rule, and it stands for the sweep unchanged.
- No `--force`, on any path, for any tree. ADR 0321's ban stands word for word.
- Salvage still runs before the remove. An unlock git refuses removes nothing, and a remove that still
  refuses after the unlock is an incident to file.

## Consequences

- A locked tree that `build retire` licenses retires without a human. Its row in the answer says
  `unlocked: true` beside its license.
- ADR 0321 is amended in part: its `--force` ban now reads as not covering an unlock. ADR 0323 is
  amended in part: its deferral of the locked case is closed by this record.
- A remove that fails after a successful unlock leaves the tree unlocked. The tree was already
  released, so the lock was guarding nothing.

## Records

no vocabulary impact
