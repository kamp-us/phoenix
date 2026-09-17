---
id: 0399
title: A landed skill change binds the next spawned shell through a session-start hook
status: accepted
date: 2026-09-16
tags: [fabrika, hooks, skills, distribution, pipeline-hardening]
---

# 0399 — A landed skill change binds the next spawned shell through a session-start hook

**What this decides:** the pipeline keeps the checkout its plugin is served from current by a
declared `SessionStart` hook, `fabrika hook plugin-sync`, and reports the one remaining link it does
not own. The two alternatives — having a spawned shell read its skill from the tree it stands in, and
having a shell compare its own preload against that tree — were checked against the harness and are
recorded here as unavailable, so neither is re-proposed from memory.

Founder ruling, 2026-09-10 PT:
[the ruling comment on #9031](https://github.com/kamp-us/phoenix/issues/9031#issuecomment-5625309469).
This record transcribes the choice and adds the two checks the issue's acceptance criteria asked for;
the choice is not the author's.

## Context

A spawned shell's `skills:` preload is not read live out of a plugin directory. Where a marketplace's
source is a **directory**, the harness copies that tree into its own plugin cache under a name keyed
by the commit the directory sat at, records that commit as the install's `gitCommitSha`, and renders
the preload out of the copy.

So a landed skill change reaches a shell only after two links close:

1. the source directory's **primary worktree** advances to the landed commit;
2. the harness **re-copies** that directory into its plugin cache.

Link 1 is an ordinary git checkout that nothing in the harness advances. Link 2 is the harness's own
`autoUpdate` pass, which runs at its own moments and which nothing in this repository drives.

The failure is silent from inside the shell. Preloaded text names no version, so an agent cannot tell
it is running retired guidance. Driving lane 9018 on 2026-09-10, an operator shell ran an `operate`
skill from before [#9009](https://github.com/kamp-us/phoenix/pull/9009) landed — its preload carried
no `LANE-WAITING` arm while the file in the same worktree carried four — and hand-rolled the poll loop
the current skill exists to forbid. The lag was noticed by accident, after terminal.

Skills are a large share of what this pipeline ships, so a fix that lands green and does not bind is
a pipeline that can correct a defect and keep exhibiting it.

## The two routes that were checked, not assumed

Both were unverified premises when [#9031](https://github.com/kamp-us/phoenix/issues/9031) was filed.
They are recorded here so the cost of each is a read rather than a re-derivation. Both checks were
made on Claude Code 2.1.273 against this machine's live install records.

**Route 2 — have the spawned shell read its skill from the tree it stands in. Not reachable.** A
builder shell spawned into a nested git worktree was handed, by the harness, a skill base directory
under the marketplace's *source* checkout — neither the worktree it was standing in nor the cache
copy path. Preload resolution follows the registered marketplace, never the spawned tree. The records
that decide it are the harness's own and carry no plugin-side knob: the marketplace registry states a
source kind and one absolute path, and the install record states a cache path and the commit it was
copied at. A plugin's own manifest — `hooks.json`, skill frontmatter — has no field that names a
resolution root. The only knob is which absolute directory the marketplace points at, and that is one
path for every worktree of every clone.

**Route 3 — a drift check inside the shell. Checkable, and blind to the failure that happened.** The
premise the filer could not check was whether a shell can read its own preload as text. It can read
*where* the preload came from: the harness hands the shell its skill's base directory, so comparing
that file against the repository checkout is two ordinary file reads. What it cannot read is the
rendered preload itself, which arrives only as context. So the check can prove the two *files* agree
and can never prove the *text the agent is running* matches either. A session that loaded the plugin
before a re-copy reads current bytes while running stale text — which is exactly lane 9018's failure,
and the check passes over it. A gate that reports clean while the defect is present is worse than no
gate, so route 3 is refused as a gate. Nothing stops it being added later as a report.

## Decision

**`fabrika hook plugin-sync` on `SessionStart`, declared in the repo's own `.claude/settings.json`.**

- **It closes link 1 and nothing else.** It resolves the clone's primary worktree from the envelope's
  `cwd` through the shared git common dir — never the session's own linked worktree — fetches
  `origin/<default>`, and fast-forwards. It selects the marketplace by the directory it declares, so
  it names no repository, marketplace or plugin, and an adopting repo needs only the declaration.
- **It takes a fast-forward and nothing else.** A parked branch, a detached HEAD, uncommitted work or
  a diverged branch is refused with its reason on stderr. Where a human's checkout sits is a human's
  call, and a hook that moved it otherwise would be trading one silent failure for a louder one.
- **It reports link 2 and never drives it.** It reads the harness's install records and names every
  install still copied from an earlier commit than the source now sits at. An unreadable record is
  UNKNOWN, never bound: a session must not be told it has current text over evidence nobody read.
  This is the arm the issue's second acceptance criterion allows — where the pipeline cannot bind, it
  says so out loud, in the session's own transcript.
- **It is enforced, not documented.** The harness fires `SessionStart`; there is no step for a driver
  to forget. Every refusal shows stderr and the session starts regardless, which is the only polarity
  available on that event and the right one for a verb that advances a checkout.

**The verb is fabrika's and the declaration is the repo's**, the same split
[ADR 0337](0337-worktree-provisioning-rehomed-onto-repo-settings.md) already makes for
`hook worktree-create`. A plugin declaration travels to every adopting repo, and a plugin that moved
a branch in every repo installing it would be mutating trees it cannot see.

## Consequences

- A skill-class merge binds the next session's spawned shells once that session has started and the
  harness has re-copied. The two links converge within one session boundary rather than waiting on a
  person, and the window is stated rather than assumed.
- Sessions already running when a skill lands keep their loaded copy. Nothing here reaches into a
  live session, and route 3's check would not detect it either — that gap is named, not closed.
- Every session start now pays one `git fetch` of the default branch in the plugin source checkout,
  inside a 120s budget.
- A checkout parked off its default branch stops advancing, loudly, at every session start until a
  human moves it. That noise is the intended reading: a plugin source that has stopped advancing is
  the state this record exists to make visible.
