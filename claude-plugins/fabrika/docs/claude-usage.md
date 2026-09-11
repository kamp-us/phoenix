# Claude usage collector

`fabrika hook claude-spend` reads a native lifecycle JSON payload on stdin. It emits only a
`systemMessage` warning on stdout and diagnostics on stderr, and exits 0 even when collection
fails. It emits no decisions, updated settings, tool inputs or model context. Events that discard
`systemMessage`, including `StopFailure` and `PreCompact`, retain stderr diagnostics; the next
ordinary session hook reports incomplete coverage again.

The [setup guide](claude-usage-setup.md) covers installation and replay.

## Attribution and discovery

The native root session identifies interactive runs. A dispatched host's `FABRIKA_SESSION_ID`
identifies its known driver run. The first hook saves that binding, so replay under another
environment does not reassign old usage. Native session plus a recorded Fabrika branch nonce
identifies the attempt. Response IDs keep genuine retry responses distinct without counting
replayed history again. A recorded build branch supplies its issue through Fabrika's existing
branch parser. PR branches and ordinary branches leave the issue unknown. Repo identity comes
from `CLAUDE_PIPELINE_REPO` or the checkout's origin remote.

`SubagentStart` saves an expected child before its transcript exists. `SubagentStop` supplies
an explicit transcript path. Every collection also walks the native root's `subagents/`
directory recursively. Child `.meta.json` files identify their spawning tool call; matching
that call to its owning transcript establishes the parent, including nested descendants.
Rows belong to their native `sessionId` and `agentId`, so copied history in another file is
excluded. A child without enough parent evidence remains visibly unmeasured until recovery.

All measurements pass through [recordUsage](../../../packages/fabrika-cli/src/spend/usage-ledger.ts).
Missing files, malformed rows and missing usage produce participant records. Every collection
records partial coverage, even after a stop: observed files and lifecycle callbacks cannot prove
that an interrupted host left a complete inventory. A later successful read adds measurements
without deleting the earlier missing-evidence records. Conflicting measurements are reported
by the shared recorder and never overwritten.

## Native counters

Each response retains its model and source version. The inspected native transcript does not
report provider routing, so `provider` is explicitly null. A model name is not evidence of a
provider endpoint. Missing optional counters remain absent; malformed counters are unavailable.
Measured zero remains measured zero.

Input, output, cache-read input and cache-creation input are additive components. The 5-minute
and 1-hour cache-creation counters are subsets of cache creation. `cached_output_tokens` is
unsupported, with no invented value. Repeated response fragments and `usage.iterations` are not
added to the response again. No prices, durations, outcomes, prompts or message bodies enter
the ledger.

## Evidence

Verified on 2026-09-10:

- [Claude lifecycle reference](https://code.claude.com/docs/en/hooks#subagentstart) documents
  child IDs at start; [SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop) distinguishes
  root and child transcript paths. [JSON output](https://code.claude.com/docs/en/hooks#json-output)
  defines the user warning field without requiring a decision.
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration)
  documents additive input components and the two cache-creation TTL subsets.
- The [metadata fixture evidence](../../../packages/fabrika-cli/src/spend/claude/fixtures/README.md)
  pins the native transcript to Claude Code 2.1.217. It establishes repeated response fragments,
  ownership fields and counters. It does not claim that a live current Claude runtime was exercised.
- [Effect LLMS.md, Writing Effect code](https://github.com/Effect-TS/effect/blob/main/LLMS.md#writing-effect-code)
  grounds the named Effect functions; the repository's beta.92 module types are the API check.

The [CLI tests](../../../packages/fabrika-cli/src/spend/claude/collector.cli.test.ts) execute the
commands read from the installed declaration with synthetic native-shaped payloads and real
filesystem transcripts. No Claude process or live model request runs in this proof.
