---
id: 0420
title: The worktree-create hook locks only its base fetch and add, and installs after the lock
status: accepted
date: 2026-09-27
tags: [fabrika, hooks, worktree, tooling, harness]
---

# 0420 — The worktree-create hook locks only its base fetch and add, and installs after the lock

**What this decides:** parallel `isolation: worktree` spawns take turns at the fetch and
`git worktree add` behind one lock per clone, and each installs its deps after letting go of it.

## Context

Worktree spawns from one clone raced each other inside `fabrika hook worktree-create`. On
2026-09-26 a driver spawned four triagers with `isolation: worktree` in one message and all four
were cancelled together; one at a time worked
([#7057](https://github.com/kamp-us/phoenix/issues/7057)). Each race had been patched on its own
path: a per-spawn fetch ref for `FETCH_HEAD`, then prune-and-retry for the two sibling-add arms. No
lock was taken, and the reason was written down: `git worktree add` fired the `post-checkout`
install, so a lock around the add would queue every spawn behind a ~10s install.

The founder bet on a root-cause fix at the 2026-09-26 weekly table:
[the bet comment](https://github.com/kamp-us/phoenix/issues/7057#issuecomment-5852494651). One
worktree owner, one repo-level lock around only the base fetch and the add, the install moved out
of the add so installs run in parallel outside the lock, and a real concurrency test.

Moving the install out reverses two recorded choices, so this record amends both:

- ADR [0337](0337-worktree-provisioning-rehomed-onto-repo-settings.md) §3 says the verb runs
  `git worktree add`, "which fires the same `post-checkout` `bootstrap-deps`".
- ADR [0178](0178-worktreecreate-hook-provisioning.md) names "move the install off `post-checkout`
  so `git worktree add` returns fast, then install separately" as its rejected alternative.

## Decision

**The hook's base fetch and `git worktree add` run inside one lock per clone, and nothing else
does; the dependency install runs after the lock is released.**

1. **One owner.** `packages/fabrika-cli/src/hook/worktree-owner.ts` is the only place the hook
   fetches a base or adds a worktree. The verb reads the envelope, runs the reap sweep and hands the
   plan over.
2. **The lock.** It is the directory `fabrika/worktree-create.lock` in the clone's common git dir,
   so every worktree of the clone shares it. A holder creates it with an atomic `mkdir` and stamps
   it with its pid, host and start time. It is held for the fetch into the per-spawn ref, the
   resolve, the ref drop and the add, and released on every exit path, refusals included. The reap
   sweep runs before it and the install after it.
3. **A dead holder never blocks.** A holder on this host whose process is gone is taken over at
   once, however young its stamp. A stamp older than 660s (the hook's 600s budget plus a margin) is
   taken over whatever its pid says. The take-over swaps the stamp inside the directory and never
   moves the directory, the same protocol the lane ledger lock uses. A waiter gives up after 240s
   and refuses at the new exit `24`, naming the holder; nothing was fetched or added.
4. **The install moves out of the add, and its body does not.** The hook adds with
   `git -c core.hooksPath=/dev/null worktree add --detach`, so the add fires no hook. After the lock
   is released it runs `git hook run --ignore-missing post-checkout -- <null-oid> <commit> 1` in the
   new tree: the same hook, with the arguments the add would have passed. The install is still
   lefthook's `post-checkout` `bootstrap-deps`, so ADR
   [0109](0109-worktree-deps-provision-not-share.md)'s rules hold unchanged: pnpm at the pinned
   major, `install --prefer-offline --ignore-scripts`, a real install into the new tree and never a
   shared `node_modules`. Exit `18` still refuses when `node_modules/.pnpm` is missing, and now also
   names the install's own failure line.
5. **`bootstrap-deps` stays on `post-checkout` for everyone else.** A human's plain
   `git worktree add` or `git checkout` still runs it, exactly as before. Only the hook's own add
   turns hooks off, and it fires the hook itself right after.
6. **Both concurrency arms stay.** The lock stops this hook's spawns from being each other's live
   sibling, but it does not reach a `git worktree add` run outside the hook (the harness's internal
   path, a human, `review-head materialize`), and it cannot clear the leftover a dead add wrote.
   So `PlaceholderHead` and `IncompleteAdminDir` keep their bounded prune-and-retry, now inside the
   lock, where its at most 3s per command is the most it adds to a sibling's wait.

This amends ADR 0337 §3 in part: the install is still reused and never reimplemented, but the add
no longer fires it. It reverses ADR 0178's rejected alternative in part: the install does move off
the add and runs separately, and the risk 0178 named, changing 0109's install contract, does not
arise because the hook body is the one install.

## Consequences

- **Parallel spawns queue only for the fetch and the add.** Measured in
  `packages/fabrika-cli/src/hook/worktree-create-lock.git.test.ts`: six hook processes started at
  once against one throwaway clone all exit 0 with a registered worktree, and their stand-in
  installs overlap.
- **A live holder stuck on its fetch holds the lock up to the fetch's 540s timeout.** Waiters
  refuse at `24` after 240s rather than hang to the hook's kill. SSH `BatchMode=yes` still makes an
  auth miss fail in seconds.
- **The hook needs git 2.36 or newer** for `git hook run`. On an older git the install step fails,
  the virtual-store check finds nothing, and the spawn refuses at `18`.
- **`hook worktree-create` gains exit `24`.** `hook codes` and the verb's help name it.
- **Turning hooks off for the add skips no guard that could fire.** A `--detach` add moves no
  branch ref, so a `reference-transaction` guard over `refs/heads/main` (ADR
  [0160](0160-ref-transaction-guard-refuses-diverging-primary-main.md)) has nothing to judge there.

## Records

no vocabulary impact
