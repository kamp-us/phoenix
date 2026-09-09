# Codex dispatch contract

`fabrika lane dispatch <lane> --harness codex --skills <absolute-directory> --worktree <absent-absolute-path> [--task <task>] [--root <lanes-root>]`

Inputs are an existing active lane, its task, installed shared Fabrika skills, a Git checkout,
and an absent worktree path outside the source and primary checkout. Multi-task lanes require
`--task`. The normal repository-derived lanes root remains the default. Dispatch accepts the
five shell states that `lane brief` emits and no other state or harness.

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
`22` means no unique new terminal. `lane brief`, lane loading, and artifact proof refusals retain
their own exit codes. Every refusal leaves stdout empty.

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
