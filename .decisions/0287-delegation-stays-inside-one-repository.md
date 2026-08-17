---
id: 0287
title: The fabrika delegation stays inside one repository, and an unprovable repository refuses
status: accepted
date: 2026-08-16
---

# The fabrika delegation stays inside one repository, and an unprovable repository refuses

## Context

`fabrika`'s bootstrap delegates an invocation to the repo-local install when the caller's copy is
not it. #4956 fenced that hand-off at the *checkout*: a copy living outside the caller's checkout
refused. That fence was too narrow. `git worktree` gives a single repository several working trees,
so the copy on `PATH` (sitting in the primary checkout) refused every invocation from a linked
worktree — one project seen twice, treated as two. That made the bare `fabrika` unusable from every
worktree (#5679), the layout every fabrika lane builds in.

## Decision

The boundary the delegation refuses to cross is the **repository**, not the checkout. This
*narrows* #4956's rule rather than dropping it: a genuinely different repo still refuses
(`refuse-foreign-checkout`, exit `126`, both checkouts named; `--skip-infer` overrides), and the
founder's amendment on #5679 is the ruling that moved the fence.

Three load-bearing choices under it:

- **The identity compared is git's own `$GIT_COMMON_DIR`**, real-path resolved so two spellings of
  one directory compare equal. Linked working trees share a common dir, so they compare as one
  repository; two clones of the same remote do not, and still refuse.
- **The common dir is read off disk, never by spawning `git`.** The bootstrap runs before any
  dependency is guaranteed linked and before there is a runtime to carry a subprocess — the same
  constraint that makes `root.ts` hand-read `pnpm-workspace.yaml`. The read follows
  `gitrepository-layout(5)`: a `.git` directory is the common dir; a `.git` file's `gitdir:` names
  this tree's git dir, whose `commondir` file names the shared common dir.
- **A checkout whose repository cannot be established is a *different* repository.** `repositoryOf`
  returns `undefined` on a non-git tree or a stale pointer, and `undefined` never compares equal —
  the direction that refuses rather than the one that answers from a tree nobody named.

## Consequences

- The bare `fabrika` works from any worktree of the repo that owns the install; only a foreign
  repo's copy refuses. Re-widening the refusal back to the checkout re-breaks every worktree —
  this record is what a future reader checks before doing that.
- Implementation: `packages/fabrika-cli/src/delegate/repository.ts` (identity) and
  `packages/fabrika-cli/src/delegate/resolve.ts` (the refusal branch); both cite this ADR.
- `packages/fabrika-cli/README.md` keeps the how-it-works walk-through; the *why* lives here.
