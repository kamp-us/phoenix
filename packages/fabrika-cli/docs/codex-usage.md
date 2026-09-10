# Codex usage collection

The Codex adapter writes through the shared [usage recorder](usage-recording.md).
It reads native session JSONL, never dispatch stdout or final `--json` output.
The [Codex setup guide](../../../claude-plugins/fabrika/guide/codex.md) installs the interactive callback.

## Supported records

The filesystem tests construct minimal native records matching the captured Codex 0.153.4 and
0.154.0 contracts. The six counters and response identity were checked against
[protocol.rs at 03f0145](https://github.com/openai/codex/blob/03f014564deef528c25e80fe67ec51871cb6ee51/codex-rs/protocol/src/protocol.rs#L2233).
`SessionMeta` supplies thread, parent, provider and version; `TurnContextItem` supplies the model
for that turn. The first session header owns the file. Later copied headers do not create attempts.
Responses naming another thread are inherited history and are skipped.

Each `token_usage_record` produces a response measurement plus separate turn and thread cumulative
snapshots. The response ID identifies each snapshot; cumulative totals are never response deltas.
Native thread ID supplies the attempt and agent identity, independent of `FABRIKA_SESSION_ID`.
Resumes reuse those identities; new responses and new threads remain separate.

Input and output are additive; cached input is a subset of input, and reasoning is a subset of
output. Total is an aggregate. Cache-write counts are preserved with unknown arithmetic meaning.
Absent counts remain absent, including cache writes; cached output is explicitly unsupported.
Provider and model remain null when unavailable. Numeric extension fields are preserved with
unknown meaning. Unknown versions, invalid counters and identity gaps produce incomplete coverage.

## Entry points and recovery

[dispatch-verb.ts](../src/lane/dispatch-verb.ts) saves the issue/run association before launching
Codex. It scans native sessions at start, every five seconds while the process runs, and on exit
or Effect interruption. The verified worktree selects native root sessions; parent links select
descendants recursively. Collection never sets model, permission or approval options.

[codex-hook.ts](../src/spend/codex-hook.ts) is the native hook entry point, separate from spend
command registration. It accepts Codex hook JSON on stdin and always returns advisory JSON.
Interactive build claims/reads, triage claims, review criteria and grilling ticket calls bind the
native turn to the named issue. Repair claims use `--issue`, not the PR operand. Review and ship
scope callbacks read the linked issue from the returned scope, never from the PR number.
Later turns retain that association. Another explicit issue in a new turn starts a new run;
two different issues in one turn are reported as ambiguous rather than reassigned.
Dispatch callbacks use the saved dispatch association instead.

Literal shell commands are read across newline, semicolon, pipe and conditional separators;
quoted words stay together. Options may precede the issue, including `--repo value` and
`--repo=value`. An unresolved issue command, shell expansion or conflicting issues produces an
advisory warning and saves an unresolved association. Later callbacks keep that warning visible
and do not inherit the previous issue for that turn. A literal issue read can resolve the binding
and replay its usage. Commands that do not name an issue continue an existing association;
without one, a Fabrika callback warns that collection has no issue association.

Bindings live under the shared Git directory's `fabrika-codex-usage` directory. The ledger lives
at `.fabrika/spend-ledger.jsonl` in the primary checkout. Each callback replays prior bound turns,
so delayed writes can recover. `SubagentStart` and `SubagentStop` retain expected child IDs even
when their transcript is missing. The session scan includes `sessions` and `archived_sessions`.
Interrupted or unsupported participant notices remain in the ledger after recovery.

The [setup guide](../../../claude-plugins/fabrika/guide/codex.md#recover-interrupted-collection)
carries the replay procedure. Native files are retained by Codex, not copied into the ledger.
If Codex removes them before collection, usage is unavailable.

Discovery is always `unknown` and coverage remains `partial`: readable files and observed callbacks
cannot prove that no unobserved descendants existed. Recording errors print a warning and do not
change the task's result. Missing or untrusted hooks cannot supply an inventory. Codex's
[hook contract](https://learn.chatgpt.com/docs/hooks) requires review of changed hook definitions
and warns that transcript format is not stable. Supporting a new native version requires fixtures
and source verification, not relaxing the version check.
