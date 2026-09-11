---
id: 0388
title: A leading directory jump out of an isolated worktree is refused, by fabrika's own hook
status: accepted
date: 2026-09-10
tags: [fabrika, pipeline-hardening, worktree, isolation, hooks]
---

# 0388 — A leading directory jump out of an isolated worktree is refused, by fabrika's own hook

**What this decides:** fabrika builds its own `PreToolUse` Bash guard, and it refuses one thing — a
command whose **leading** `cd`/`pushd` resolves outside the linked worktree the command runs in,
whatever follows that jump, and read through the groupings and `VAR=value` prefixes the jump can be
written inside. The guard arms only inside a linked worktree, denies through the
harness's JSON decision rather than through an exit code, and lives in `packages/fabrika-cli/src/hook/`
rather than inside any `build` verb.

Founder ruling on [#6072](https://github.com/kamp-us/phoenix/issues/6072), 2026-09-06 — *build our
own check on the leading directory jump; it happened twice for real and needs no ruling reversal*.
This record is the transcription and the ground under it.

## The problem

Claude Code's worktree isolation guard reads the **command text**. Measured on 2.1.233 from inside a
live isolated agent, it refuses `git -C <shared>`, `--git-dir=`, `GIT_DIR=`, and
`cd <shared> && git status` — each by name — and allows `cd <shared> && ls`. So the check is a match
on the token `git`, not a fact about where the process ends up acting.

A program that reaches git in a **child process** carries no such token. `cd <shared> && node
packages/fabrika-cli/src/bin.ts build branch <n>` runs, exits 0, prints a normal-looking branch name,
and leaves the shared checkout standing off `main` on the lane branch — `build branch` reaches
`git switch -c` through `switchToNew` in `packages/fabrika-cli/src/build/git.ts`. The global
`fabrika` binstub does the same; nothing about the escape is specific to invoking the bin through
node.

It happened twice, both first-hand: the filing (2026-08-18, epic #5631 / child #6297) and the
recurrence (2026-09-04, on #7791). Both times the coverage was **inverted** — the harness permitted
the write and refused the repair, so the agent that noticed could not switch the checkout back, and
both incidents left residue for a human to clear. The first was self-limiting only because that
checkout happened to be clean; a branch switch under uncommitted work is a different conversation.

The record that graded this class, `.patterns/fabrika-hook-records.md`'s `worktree-guard pre-bash`
section, concluded *the `HEAD_MOVING` refusal loses nothing: every path it covered is refused one
layer down*, and re-scoped the port to the stage-all refusal on that basis. The claim is false and
is corrected in the same change as this record.

## The decision

### The refusal is keyed on the jump, not on what follows it

What follows a `cd` is a program, and what a program does is not decidable from the command string —
that is the whole reason the harness's textual check misses this. The **jump** is decidable: a
literal target resolves against the cwd, and either lands inside the isolated tree or does not. So
the guard reads the leading jump, resolves it, and refuses an escape whatever comes after the `&&`.

`pushd` is refused on the same footing. The ruling names the act — a leading directory jump — rather
than one spelling of it.

A target that only exists once the shell has expanded it (`cd "$SHARED"`, a glob, `cd -`) is refused
rather than resolved. That is the same polarity the harness itself takes when it answers *too complex
to verify that it stays inside the worktree*, and the alternative — reading an unresolvable target as
harmless — is a one-token bypass of the whole guard.

### The jump is read through the wrappers it can be written inside

`(cd <shared> && node …)`, `{ cd <shared>; node …; }` and `VAR=x cd <shared>` are the same act as the
bare jump, one keystroke away, and a parse that reads only the raw first token lets all three
through. So the parse strips what it can strip **from the text alone** before it looks for the
keyword: a subshell opener, a command substitution (`$(`, a backtick), a brace group's `{` when a
space follows it, and any run of `NAME=value` prefixes — repeatedly, in any order, shedding the
matching closer off the tail so `(cd /x)` reads as a jump to `/x` rather than to `/x)`.

Stripping is confined to wrappers whose removal is decidable without running anything, which is the
same line the target resolution draws. A brace group needs its space (`{cd,ls}` is a brace
*expansion*, and a command so named is not a jump), and nothing that requires knowing what a word
means at run time is unwrapped.

### What stays out of key

**The guard does not claim to close every escape**, and the bound is the part a reader must be able
to trust, so the shapes it knowingly allows are listed rather than left to be discovered:

- **A jump that is not the command's first act.** `pnpm test && cd <shared> && node …` is allowed.
  Judging every `cd` on the line means judging a sequence whose earlier commands can move the cwd,
  which is no longer decidable from the text.
- **A jump behind a word whose meaning is run-time.** `eval "cd <shared> && …"`, `env cd <shared>`,
  `command cd <shared>`, `xargs`, and a wrapper script that jumps for itself all carry no
  strippable leading jump. Unwrapping them means resolving what a name refers to, which this module
  refuses to start doing.
- **Reaching another checkout with no jump at all.** An absolute path handed to a program that acts
  on it is untouched by this guard, and always was: what is keyed is the jump, because the jump is
  what is decidable.

Each of these is an escape a determined agent can still write. The guard is a floor under an
accident, not a sandbox against intent — and the two field incidents were accidents.

### It arms only inside a linked worktree

In the primary checkout there is nothing to escape from, and which tree an operator works in is
their call, made at spawn time — the 2026-08-13 ruling on
[#5386](https://github.com/kamp-us/phoenix/issues/5386), which `packages/fabrika-cli/src/build/tree.ts`
states in its own header. This decision does not reverse it: what is judged is *leaving* an isolated
tree, never *standing* in one. The two facts come off `deriveRepoRoot` — a cwd whose working tree is
its own repository root is the primary checkout and is allowed untouched, as is a cwd under no
repository at all.

### The guard is a hook, and never a location check inside a `build` verb

The filing's other candidate was making `build branch` refuse when its cwd is outside the tree it
proved. That reverses #5386's ruling and needs the founder, not a builder. The hook needs no location
opinion inside any verb: it judges a command string against the tree the harness says the command
runs in, and every `build` verb stays location-neutral.

### A deny travels as JSON; an allow carries no decision at all

On `PreToolUse`, exit `2` is the harness's one blocking code and fabrika allocates it nowhere
(ADR 0331's polarity, pinned by `pretooluse-polarity.cli.test.ts`). So the deny rides
`hookSpecificOutput.permissionDecision` at exit 0, and every refusal arm of the verb exits
non-blocking.

The allow side is the half that is easy to get wrong: `permissionDecision: "allow"` is **not** "no
objection" to the harness — it bypasses the permission rules the operator configured. A guard that
answered `"allow"` on every command it had nothing to say about would silently disable the
permission system on every Bash call. So an allow carries a fabrika-namespaced token the harness
ignores: a positive answer for the interface convention, and no decision for the harness.

### A ground it cannot read fails open, and says so

An unprobeable cwd is a state in which nothing was judged, and a guard that judged nothing may not
deny (`hook-surface.md`, *The dispatch-failure policy point*). It seats its own exit code (`19`),
which shows stderr to the user and lets the command through — fail-open **and loud**, never silent.

## Consequences

- fabrika now ships a hook that decides something. The surface's *no fabrika hook decides anything
  today* is retired, and the `PreToolUse` bootstrap exposure that page described as latent is live:
  a bootstrap failure seated on `2` would block every Bash call in the session, not merely a spawn.
- The plugin's `hooks.json` carries the declaration, so it travels to every adopting repo. That is
  bounded in the way the `WorktreeCreate` refusal is not: a `PreToolUse` hook that cannot run
  produces no decision, which the harness reads as no objection, so a repo with no fabrika install
  loses the defence rather than the capability.
- A leading jump out of the worktree is no longer a way to reach a scratch directory. Absolute paths
  are, and the refusal text says so — the guard closes no route that has no replacement.
- The stage-all refusal this record's predecessor scoped to #5195 still has no owner; #5195 was
  closed `NOT_PLANNED` in the 2026-08-19 p2 purge and its criteria carry nothing.
