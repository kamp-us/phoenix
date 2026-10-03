---
id: 0439
title: A git stash in a linked worktree is refused by fabrika's own hook, never restated in each lane skill
status: accepted
date: 2026-09-30
tags: [fabrika, pipeline-hardening, worktree, isolation, hooks]
---

# 0439 — A git stash in a linked worktree is refused by fabrika's own hook, never restated in each lane skill

**What this decides:** fabrika ships a second `PreToolUse`/`Bash` guard, `fabrika hook stash-guard`.
It denies any `git stash` run where `git rev-parse --git-dir` and `--git-common-dir` differ — a
linked worktree — whichever skill the shell runs. The never-stash rule is not copied into the
`review`, `ship`, `build-ui` or `operate` skills. `build`'s §4 sentence stays where it is.

Founder ruling on [#6844](https://github.com/kamp-us/phoenix/issues/6844), 2026-09-02:
<https://github.com/kamp-us/phoenix/issues/6844#issuecomment-5519865462>. The ruling picked the
mechanical guard over the three prose remedies (restate per skill, hoist into a shared preamble,
rely on the pattern doc alone), and rejected those three. Its lens: cut process toil, raise trust
between agents and skills, and add no new gate unless a failure actually recurred. This record
writes that ruling down, per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

## Context

`refs/stash` lives in the common git dir, so every worktree of a clone pushes to and pops from one
stack. A pop can restore a sibling lane's files into your tree and drop their entry. Neither
command warns. Scoping does not help: `git -C "$WT" stash push` is correctly addressed and still
writes the shared stack.

It happened twice:

- [#2030](https://github.com/kamp-us/phoenix/issues/2030): a review agent's `git stash pop` and
  `reset --hard` discarded uncommitted work on the owner's primary checkout.
- [#6701](https://github.com/kamp-us/phoenix/issues/6701): two build lanes of one epic popped each
  other's entries on 2026-08-20.

[#6701](https://github.com/kamp-us/phoenix/issues/6701) landed the rule as one sentence in `build`'s
§4. Every other lane shell (reviewer, shipper, ui-builder, operator) runs in a worktree of the same
clone and has the same hazard, and none of their skills carries the rule. The review shell, the one
with a recorded incident, was not covered.

## Decision

**A `git stash` in a linked worktree is denied by a fabrika hook, so the rule holds in every shell
without any shell reading it.**

### Why a new gate is admitted

ADR [0430](0430-fabrika-helps-never-polices-choices.md) asks one question of a guard: does it stop a
real failure, or only a choice? This one stops an accident that loses another lane's work, and it
has recurred twice, from two different skills. That recurrence is what the ruling's no-new-gate lens
asks for. No lane needs `git stash` in a linked worktree: committing to the lane branch and
resetting back does the same job on a ref only that lane names.

### What it denies

- **Any form of `git stash`**: `push`, `pop`, `apply`, `list`, a bare `git stash`, and a `git -C
  <dir> stash`. The pattern doc's rule is *never, in any form*, and the recovery path it gives
  (`git fsck --unreachable`, `git restore --source=<sha>`) needs no `git stash` at all.
- **Only where the two git dirs differ**, read with `git rev-parse --path-format=absolute --git-dir
  --git-common-dir` in the envelope's `cwd`. Where they agree the checkout is not a linked worktree
  and the stash is let through. Absolute paths keep a `cwd` reached through a symlink from reading
  as two dirs.
- The command is read for every simple command on the line: inside `$( )`, backticks, subshells,
  brace groups, `sh -c '…'` and `eval`, and past `VAR=value` prefixes and wrapper words. The probe
  runs only when the line has a `git stash`, so other Bash calls cost no subprocess.

### What stays out of key

- A `git` reached through an alias, a shell function, a variable, `xargs` or `find -exec`.
- A here-document body, which is read as data.
- The primary checkout. It shares the stack with its linked worktrees, but the ruling keys the
  refusal on the two dirs differing, and which tree an operator works in is their call (the
  [#5386](https://github.com/kamp-us/phoenix/issues/5386) ruling ADR
  [0388](0388-a-leading-directory-jump-out-of-an-isolated-worktree-is-refused.md) also keeps).

The guard is a floor under an accident, not a sandbox against intent.

### The deny rides JSON, never exit `2`

On `PreToolUse`, exit `2` is the harness's one blocking code, and fabrika allocates it nowhere. So
the deny is exit `0` carrying `hookSpecificOutput.permissionDecision: "deny"`, the same as
`hook pre-bash`. An allow carries no decision field, because `"allow"` would bypass the operator's
own permission rules.

Every state in which nothing was judged fails open and loud, per ADR
[0250](0250-fabrika-hook-cannot-run-fails-open.md): an unreadable envelope, a relative `cwd`, a `cwd`
git cannot start in, a `git rev-parse` that fails or passes its 5s timeout. Each exits on a
non-blocking code with stderr saying the stash guard did not run, and the command proceeds. The
unreadable-dirs states reuse exit `19`, whose meaning — the cwd's working tree could not be
established — already covers them, so no code is added.

### Where it sits relative to ADR 0331

ADR [0331](0331-fabrika-spawn-hook-retired.md) retired `fabrika hook spawn`, the last denying
`PreToolUse` hook of its time, because it policed a human's model choice. ADR
[0388](0388-a-leading-directory-jump-out-of-an-isolated-worktree-is-refused.md) brought a denying
`PreToolUse` hook back for a recurred accident. This is the second, on the same footing. Neither
reverses 0331: what it retired was a guard on a choice, and these guard failures.

**Binding constraints.**

- The never-stash rule is enforced by the hook. It is not restated in the `review`, `ship`,
  `build-ui` or `operate` skills.
- The verb's deny is JSON at exit `0`. No path of it exits `2`.
- A state in which the guard judged nothing lets the command through and says so on stderr.

## Consequences

- Every fabrika shell in a linked worktree loses `git stash`, including read-only `list` and `show`.
- The plugin's `hooks.json` carries the declaration, so it travels to every adopting repo. A repo
  where `fabrika` does not resolve loses the defence, not the capability; the pattern doc's prose
  rule still binds there.
- `claude-plugins/fabrika/docs/hook-surface.md` now names two hooks that decide something, and
  `.patterns/worktree-agent-constraints.md` names this guard as the rule's enforcement.
