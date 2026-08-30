# Delegation reference

Which copy of `fabrika` serves an invocation, and what each outcome does.

You can have more than one copy of `fabrika` on a machine: a global install on `PATH`, and a copy
inside whatever repo you are standing in. Before any verb runs, the bootstrap decides which of them
serves the command you typed. This page describes that decision.

The decision is implemented in
[`packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts)
(the outcomes) and
[`packages/fabrika-cli/src/delegate/repository.ts`](../../../packages/fabrika-cli/src/delegate/repository.ts)
(repository identity), with the process boundary in
[`entry.ts`](../../../packages/fabrika-cli/src/delegate/entry.ts). The rule the refusal enforces is
[ADR 0287](../../../.decisions/0287-delegation-stays-inside-one-repository.md).

## The four facts

`resolve` is a pure function of four inputs and nothing else.

| Fact | Value | Where it comes from |
|---|---|---|
| `selfPackageRoot` | the real path of the package root the running bin belongs to | `entry.ts`, real-path resolved from the bin's own module URL |
| `origin` | `same-repository`, or `other-repository` carrying the running copy's checkout | `relateCopy` in `repository.ts` |
| `repoRoot` | the repo root at or above the cwd, or `undefined` when the cwd is in no repo | `discoverRepoRoot` in [`root.ts`](../../../packages/fabrika-cli/src/delegate/root.ts) |
| `local` | `found` with an install, `absent`, `corrupt` with a reason, or `undefined` when there is no repo root to probe | `probeLocalInstall` in [`local.ts`](../../../packages/fabrika-cli/src/delegate/local.ts) |

`repoRoot` is the nearest ancestor holding a `package.json`, except that a higher ancestor wins when
its workspace globs match that nearest package. The globs come from `pnpm-workspace.yaml`'s
`packages:` list when that file is present, otherwise from the manifest's `workspaces` field.

`local` is resolved by Node's own resolver — `createRequire(<repoRoot>/package.json).resolve` on
`@kampus/fabrika-cli/package.json` — so pnpm's symlinked layout, hoisting and unusual nesting all
resolve correctly. `corrupt` covers a manifest that is not valid JSON, declares no `version`,
declares no `fabrika` bin, cannot be read, or names a bin that is not on disk.

## Outcomes

`resolve` is total over five states with no fallthrough. The rows below are in the order the
branches are taken.

| Condition | Outcome | What happens | Exit code |
|---|---|---|---|
| `repoRoot` is `undefined` | `run-here` | the invoked copy serves the command, silently | the verb's own |
| `local` is `undefined`, `absent` or `corrupt` | `warn-and-run-here` | a warning on stderr, then the invoked copy serves the command | the verb's own |
| `local.install.packageRoot === selfPackageRoot` | `run-here` | the invoked copy *is* the repo-local install; it serves the command silently | the verb's own |
| `origin` is `other-repository` | `refuse-foreign-checkout` | the refusal text on stderr; nothing runs | `126` |
| otherwise | `delegate` | the repo-local bin runs as a child; stdin, stdout and stderr are all inherited | the child's exit status, or the child's own signal re-raised on this process |

Two notes on `delegate`. The child is spawned as `<node> <binPath> --skip-infer <args>` with its cwd
set to the **repo root**, not yours; your cwd travels to it in `FABRIKA_INVOCATION_DIR`. A spawn that
fails to start prints `found a repo-local install but could not run it` and exits `126` — the same
code as the refusal, and distinct from `1` (a verb's usage error) and `127` (nothing ran at all).

Only two outcomes are silent: `run-here` in both of its forms. `warn-and-run-here` always prints
unless `FABRIKA_GLOBAL_WARNING_DISABLED` is set, and `refuse-foreign-checkout` always prints. The
incidents behind the current shape are
[#4784](https://github.com/kamp-us/phoenix/issues/4784) (the silent-branch rule),
[#4956](https://github.com/kamp-us/phoenix/issues/4956) (the foreign-copy refusal) and
[#5679](https://github.com/kamp-us/phoenix/issues/5679) (worktrees are one repository, not two); the
reasoning is in [ADR 0287](../../../.decisions/0287-delegation-stays-inside-one-repository.md).

### The refusal's text

`foreignCheckoutRefusal` prints the invoked copy and its checkout, your cwd's repo root and the bin
and version that root *would* have run, the line `Delegating would have answered from a repository
you did not name`, and the two ways out: re-run with the cwd inside the invoked copy's checkout, or
pass `--skip-infer`.

### The warning's text

`globalWarning` prints the repo root and why its local install was unusable, the global's version,
and either the version the root manifest declares for `@kampus/fabrika-cli` or the fact that it
declares none. Both versions appear, so the mismatch is readable at once.

## Repository identity

`other-repository` is the only state that refuses, so what counts as "other" is the whole boundary.

The identity compared is git's `$GIT_COMMON_DIR`, real-path resolved so two spellings of one
directory compare equal. `repositoryOf` reads it **off disk and never by spawning `git`** — the
bootstrap runs before any dependency is guaranteed linked. The read follows
`gitrepository-layout(5)`: a `.git` directory *is* the common dir; a `.git` file's `gitdir:` line
names this tree's git dir, whose `commondir` file names the shared common dir.

- A linked `git worktree` shares a common dir with its primary checkout, so the two are the **same**
  repository.
- Two clones of one remote have different common dirs, so they are different repositories and the
  foreign copy refuses.
- A checkout whose repository cannot be established — a non-git tree, a stale `gitdir:` pointer, a
  `commondir` naming a path that is gone — yields `undefined`, and `undefined` never compares equal.
  An unprovable repository is treated as a different one, so it refuses rather than answering from a
  tree nobody named.

`relateCopy` short-circuits before touching git plumbing in three cases, all answering
`same-repository`: the running copy is an installed artifact with no checkout (any path holding a
`node_modules` segment), the cwd is in no repo at all, or the cwd's repo root *is* the copy's own
checkout root. Only a genuine second tree costs the two reads.

## Flags and environment

| Name | Kind | Effect |
|---|---|---|
| `--skip-infer` | flag | Skips the whole decision; the copy you invoked serves the command. Stripped from argv before any verb sees it, and read before any filesystem work. It is also how a delegated child avoids recursing. |
| `FABRIKA_SKIP_INFER` | env, any value | The same guard for a caller who cannot alter argv. |
| `FABRIKA_INVOCATION_DIR` | env, set by the parent | Carries your original cwd to the delegated child, whose own cwd is the repo root. Read it instead of `process.cwd()` when a verb needs where the user actually stood. |
| `FABRIKA_GLOBAL_WARNING_DISABLED` | env, any value | Silences the `warn-and-run-here` warning. The branch still takes; only the message goes. |
| `FABRIKA_DEBUG` | env, any value | Prints one stderr line naming which copy serves this invocation and why. Without it the delegation is unobservable — both copies print identical bytes. |

Reach for `--skip-infer` when you mean the copy you named, most often when running a checkout's
source directly from a tree in another repository. Reach for `FABRIKA_DEBUG` when a verb's answer
describes a tree you did not expect.

## What this means for a consumer repo

A repo-local install pins the version, so a repo that installs `@kampus/fabrika-cli` gets that
version whether the caller typed the global `fabrika` or not. A repo that does not install it is not
broken: the global runs and the warning names the gap. So a consumer repo does not need
`fabrika-cli` in its own `package.json` for delegation's sake; the only copy that refuses outright is
one invoked from a different repository.

Verb-by-verb behaviour and exit codes live in
[`packages/fabrika-cli/docs/verb-reference.md`](../../../packages/fabrika-cli/docs/verb-reference.md);
the delegation-outcome table and the environment variables are in
[`packages/fabrika-cli/docs/packaging.md`](../../../packages/fabrika-cli/docs/packaging.md).
