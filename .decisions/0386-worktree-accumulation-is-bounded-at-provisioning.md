---
id: 0386
title: Worktree accumulation is bounded at provisioning, by the sweep that creates one
status: accepted
date: 2026-09-10
tags: [fabrika, pipeline-hardening, worktree, isolation]
---

# 0386 — Worktree accumulation is bounded at provisioning, by the sweep that creates one

**What this decides:** three things about how this repository stops filling its own disk with dead
worktrees. `build reap` sweeps **both** namings the harness registers under, not just its own. The
sweep runs **before every provisioning**, as a child of `hook worktree-create` — there is no
scheduled chore lane and no cap on live trees. And clearing a **stale registration** is `build
reap`'s work, inside the same pass, not a separate verb.

Founder ruling on [#7990](https://github.com/kamp-us/phoenix/issues/7990), 2026-09-05, answering the
three questions that filing left open. This record is the transcription and the ground under it.

## The problem

The operator's data volume filled to 100%, and a full volume refuses every `isolation: worktree`
spawn — so the pipeline stopped itself: no builder, no reviewer, no shipper, and each refusal reading
like a lane defect rather than a machine one. `build reap` already existed and could not reach most
of what had accumulated.

Three gaps sat under the symptom, and the ruling answers each.

## 1. Both namings, because the trees exist either way

`build reap` matched a registration only under `<repo>/.claude/worktrees/agent-*` — `hook
worktree-create`'s own layout. The harness registers a second population under its own naming,
`pi-worktree-<uuid>-sN-0`, and that one does not sit under the repository at all.

Measured on the operator clone on 2026-09-10, the one snapshot every surface quotes: of 352
harness-provisioned registrations, 243 carried the first naming and 109 the second. Every removable tree the widened sweep found — **78 of them** — was of the
second naming, each carrying its own installed `node_modules` (ADR
[0109](0109-worktree-deps-provision-not-share.md)) at 1.81 GB, so roughly **141 GB** was structurally
invisible to the only sanctioned sweep.

The alternative was to call the second naming the provisioner's bug and fix where the trees are
created. The ruling refuses that: the trees exist either way, and a sweep that cannot see a
population is broken regardless of who named it. So the second naming is matched on the leaf's own
name and nothing about where it sits — keying it to a temp root would narrow out the copies that do
not live there.

Widening the population moves no polarity. Each tree of either naming still needs the same positive
proofs, and the live sweep kept six second-naming trees on exactly that ground ("it carries work
`origin/main` does not").

## 2. Reap before provision, not a schedule and not a cap

Nothing ran `build reap`. It was invoked by hand, on no schedule, with no bound on how many trees
could accumulate — which is the clause that made the failure recur: freeing the disk bought time, not
a fix.

The mechanism is **whatever creates a worktree reaps first**. `hook worktree-create` runs the sweep
as a bounded child before it fetches or adds anything. One tree is created per spawn and up to four
are reclaimed at the same moment, so the population shrinks whenever anything is reclaimable and a
backlog drains rather than merely holds.

Two alternatives were on the table and are refused. A **scheduled chore lane** puts the bound
somewhere the failure is not: the disk fills through spawning, and a schedule is a fixed rate against
a variable one. A **hard cap that refuses the spawn** converts an accumulation problem into the exact
total stop this record exists to end.

Three properties make it safe to run there:

- **It cannot refuse a spawn.** Every outcome of the sweep — a failure, a timeout, a clone it could
  not read — is a stderr line and never a refusal. A reclaimer that could block a spawn would turn a
  housekeeping miss into a pipeline stop.
- **It is bounded twice.** At most four removals, and a timeout well inside the hook's 600s budget
  with the fetch and the add still to pay for. A sweep the timeout cuts off loses nothing: `build
  reap` journals each removal as it happens, and its verdicts are re-derived on the next spawn.
- **It runs as a child, not a call.** This package's git seam runs every command in the process's own
  cwd, and a hook's cwd is the harness's business, while the sweep must read the registrations of the
  repository the envelope names. `process.execPath` plus this process's own entry module keep it the
  same build of the CLI the hook is running from.

**The scan had to get cheap before this was viable.** A sweep of 243 trees cost 42.8s, because every
tree paid for a `git status` and a containment scan whose answer no verdict arm ever consulted — 230
of the 243 were settled by the registration's own fields plus one stat. Those arms now run first, and
the git reads are paid only by what they leave open. That is a pure reordering: the arms and their
order are unchanged, so no tree's verdict moves.

## 3. Pruning lives inside `build reap`

`classify` returned KEEP on a registration git already called prunable, with the reason "`git
worktree prune` clears the registration" — and no fabrika verb ran `git worktree prune`. The filing
counted ~794 such records on the operator clone, and they slow every repository read independently of
the disk.

A registration whose directory is gone is now seated **`Prune`** rather than `Remove` or `Keep`: there
is no checkout to be unsafe about, so the sweep clears the record instead of a tree. That runs in the
same `--execute` pass, and the one `git worktree prune` it runs is clone-wide: it clears the entries
the sweep seated `Prune`, the registrations each removal just left behind, and any stale entry
outside the swept population too. The population filter bounds what is **judged**, not what is
cleared, and that is git's own absence-and-lock criteria doing the deciding rather than this verb's.
`--limit` does not bound it either: a registration is a line in a file, not a tree to delete.

It answers to the same read-back discipline as a removal, but a survivor is **reported without
redding the sweep** — a stale record costs disk nothing and risks no work.

**Absence is proved by one stat's own `NotFound`, never by a failed read and never by git's
`prunable` flag.** `FileSystem.stat` folds every failure into a `PlatformError`, and only
`reason._tag === "NotFound"` is a not-there; a `PermissionDenied` or an unmounted volume arrives as
some other tag and keeps the tree. Verified against this repo's `effect@4.0.0-beta.92` under
`NodeServices.layer`.

git's `prunable` is deliberately **not** a second source, and reading it as one was the mistake this
record's first draft shipped. Its condition is the worktree's `.git` file, not the worktree
directory: measured against real git 2.40.1, a linked worktree whose `.git` file is deleted while its
directory stays reports `prunable gitdir file points to non-existent location` with uncommitted work
still on disk, and pruning it deletes `.git/worktrees/<id>` — the HEAD, index and reflog of that
worktree, so a commit that exists only there loses its only ref. Seating `Gone` off that flag would
have cleared exactly such a record. The stat costs nothing extra, since the sweep already performs it
for every other tree, and it is the wider source anyway: a registration that really is prunable
because its directory is gone answers `NotFound`, and the locked-and-gone entries below are reachable
only through the stat.

**A lock whose tree is gone is dropped first.** `git worktree prune` skips a locked entry, which is
right while a checkout exists and wrong once it does not. Fourteen of the operator clone's
registrations sat in exactly that state, locked by a harness process dead since August with their
directories long gone, and no sweep could ever have reached them. Absence is the license, and it is
the only one: `git worktree unlock` runs only where the directory is proved gone.

All four claims about git are measured against real git in
`packages/fabrika-cli/src/build/stale-registration.git.test.ts`, not reasoned about — that a direct
prune needs no `--expire` window, that it skips a locked stale entry, that it leaves a live
registration alone however often it runs, and that `prunable` tracks the `.git` file rather than the
directory, so a registration reports prunable while its checkout still holds uncommitted work.

## What does not change

`build reap`'s fail-safe polarity, exactly as ADRs [0321](0321-dead-spawn-worktree-ownership.md) and
[0323](0323-board-licensed-worktree-retirement.md) leave it: anything short of positive proof that a
tree carries nothing is a KEEP, `--force` is banned on every path, and a read that failed proves
nothing. Nothing here makes a dirty, locked, or unreadable tree removable. The `Prune` arm is a
widening of that rule rather than a hole in it — absence is the strongest positive proof the sweep
deals in.

## Measured on the operator clone, 2026-09-10

| | before | after |
|---|---|---|
| registrations | 435 | 418 |
| population the sweep can see | 243 | 352 |
| removable trees it can see | 0 | 78 |
| a full dry-run scan | 42.8s | 18.3s |

One bounded `--execute --limit 4` pass removed 4 trees (7.2 GB) and pruned 14 stale registrations,
including all fourteen locked-and-gone ones. One spawn registered a new tree during the run, which is
why 435 − 18 reads as 418. The remaining 74 removable trees drain four per spawn, by design: that
draining is the mechanism, not a leftover.
