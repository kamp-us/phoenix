# Codex lane dispatch

The [dispatch verb](../packages/fabrika-cli/src/lane/dispatch-verb.ts) adapts the existing lane
brief to a Codex child process. Its [pure module](../packages/fabrika-cli/src/lane/codex-dispatch.ts)
owns role-to-skill selection and the fixed preload envelope. The brief remains byte-identical
inside that envelope; it is never summarized by the driver. No Codex configuration override is
needed to preload a stage, so configured developer instructions remain present.

Git worktree creation precedes child execution. The verb verifies the root, common repository,
commit and cleanliness before running repository setup or Codex. An exclusive per-task lock
prevents duplicate dispatch; it is separate from the ledger append lock because a child must
remain able to record its terminal while the dispatcher waits.

Completion requires both a new task report and fresh artifact evidence.
[The shared prover](../packages/fabrika-cli/src/lane/prove-verb.ts) accepts an internal captured
lane snapshot for this second read: re-reading the current post-report state would ask what the
*next* stage owes. The snapshot changes only state selection; the board and Git evidence are
still read live. There is no CLI override to bypass state selection.

[Real-Git integration tests](../packages/fabrika-cli/src/lane/dispatch.integration.test.ts) exercise
the actual child cwd with a fake Codex executable. They establish isolation and handoff behavior,
not model adherence. This pattern applies to Fabrika lane stages, not ordinary Codex subagents.

The Effect shape follows [LLMS.md — Working with child processes and Writing Effect code](https://github.com/Effect-TS/effect/blob/main/LLMS.md).
At the repository's beta pin, `ChildProcess.make` supports `cwd`, `env`, `extendEnv` and streamed
stdin; implementation grounds those options in the installed `effect/unstable/process` source.
Codex configuration and CLI references are linked in [the Codex guide](../claude-plugins/fabrika/guide/codex.md).
