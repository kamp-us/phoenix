# Codex dispatch contract

`fabrika lane dispatch <lane> --harness codex --skills <absolute-directory> --worktree <absent-absolute-path> [--task <task>] [--root <lanes-root>]`

Inputs are an existing active lane, its task, installed shared Fabrika skills, a Git checkout,
and an absent worktree path outside the source and primary checkout. Multi-task lanes require
`--task`. The normal repository-derived lanes root remains the default. Dispatch accepts the
five shell states that `lane brief` emits and no other state or harness.

On an epic run's child the verb first refreshes the assembly branch the worktree will be cut from,
through `lane refresh`'s own code and before the brief is emitted, gated by
`assemblyRefresh.onDispatch`. The shipped `off` fetches, merges and reads nothing, so a repo that
declared nothing keeps the dispatch path it has today; `on` merges the trunk in, so the child builds
and runs its verbs in a tree at least as new as the trunk. Exit `42` there is a real conflict: the
merge is aborted, the branch is proven back at its pre-merge head, and no worktree is created —
record the park it names (`--cause assembly-conflict`) rather than dispatching over the stale branch.
A lane the verb cannot read here is left to the reads below, which refuse in their own words.

The verb reads `lane brief`, captures the task's state, validates its role skills, then takes
a per-task dispatch lock. It creates and verifies a detached worktree at the source commit,
or the epic assembly branch for an epic child. It runs the declared dependency reconciler and
refuses if that process fails or changes tracked files. It starts `codex exec --cd` with the
fixed skill preload envelope and the emitted brief as stdin. It passes no model or policy flags.

Output on success is `{harness, task, event, worktree}`. Success means the child exited zero,
the original ledger prefix remains intact, exactly one new terminal addresses the task, the
updated ledger folds, and the existing artifact prover confirms that event against the captured
pre-dispatch state using fresh evidence. The event can be a failure or park; callers route from
the lane state, not from the dispatch exit code. stdout text from the child is never proof.

Exit `11` means an input, worktree, process, or lane read failed; `18` means no supported dispatch;
`22` means no unique new terminal. `lane refresh`, `lane brief`, lane loading, and artifact proof
refusals retain their own exit codes — including `lane brief`'s `59`, the assembly branch not
carrying a lane verb the brief instructs the shell to run. Every refusal leaves stdout empty.

All created worktrees remain on disk, including clean successful ones. Child output is captured
beside the ledger as `dispatch-<task>.stdout` and `dispatch-<task>.stderr`. Inspect those files and
the worktree before recovery. The dispatch lock is removed when the process exits normally or is
interrupted through Effect; a killed dispatcher may leave its lock directory. Confirm that its
process is gone before removing a stale lock. Do not delete or reset a worktree merely to retry.

Example:

```bash
fabrika lane dispatch 123 --harness codex --skills /installed/fabrika/skills --worktree /scratch/lane-123
```

See [using Codex](../../../claude-plugins/fabrika/guide/codex.md) for installation and configuration.
