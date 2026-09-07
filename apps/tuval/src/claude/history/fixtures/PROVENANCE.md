# Provenance — Claude Agent SDK message fixtures

Captured from real runs, per
[`.patterns/golden-real-payload-fixtures.md`](../../../../../../.patterns/golden-real-payload-fixtures.md)
and ADR [0180](../../../../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md).
Nothing here is hand-authored: the SDK's message shapes are observable only at execution, so an
invented envelope would prove the mapping against a contract nobody emits.

Most of them came off `query()`. Three did not, because no `query()` run can force what they carry;
they were excerpted from an operator's own CLI session log and re-keyed to the SDK's declared
envelope, and the section below says exactly which part of each is the captured part.

## What produced them

The rows below describe the `query()` captures; the last three fixtures have their own section.

| | |
|---|---|
| Captured | 2026-09-04, and `streaming-turn.json` on 2026-09-06 |
| SDK | `@anthropic-ai/claude-agent-sdk` **0.3.259** (the `pnpm-workspace.yaml` catalog pin) |
| CLI | `claude_code_version` **2.1.259**, as reported by the `init` frame itself |
| Models | `claude-fable-5-1` on every capture but `interrupted-assistant.json`, which is `claude-opus-5` |

`streaming-turn.json` is the one capture taken with `includePartialMessages` on, and it is what
proves that turning the flag on costs the finished transcript nothing. It has to be its own run:
`sdk.d.ts` warns at `SDKAssistantMessage` that with partials on a turn's finished `assistant` frame
"typically holds the single block this message delivers and `stop_reason` is still null", so the
flag changes the frames a *non*-streaming reader sees, and only a capture can settle what it
changes them to. This one carries exactly that shape — `stop_reason: null` on the finished frame,
which arrives before `content_block_stop` — and `events.unit.test.ts` folds it twice, once whole and
once with the `stream_event` frames dropped, to prove the two transcripts agree.

Each run drove `query()` from a throwaway cwd and wrote every message the async iterator yielded,
in order.

| Fixture | How the run forced it |
|---|---|
| `init.json`, `assistant-turn.json` | one prompt, no tools |
| `resumed-init.json` | a second `query()` with `resume: <the same session id>` |
| `tool-turn.json` | a prompt asking for `echo hello-tuval` with `allowedTools: ["Bash"]` |
| `oversized-tool-turn.json` | the same, running `seq 1 2000` — an 8,892-byte result, over the 8,000-byte per-item bound |
| `error-result.json` | a three-command prompt under `maxTurns: 1`, which ends `error_max_turns` |
| `permission-denied.json` | `permissionMode: "dontAsk"` with a project `permissions.deny` rule of `Bash(echo:*)` — the tool stays on the list and the *call* is refused, which is what emits the frame; denying `Bash` outright removes the tool instead and emits nothing |
| `interrupted-assistant.json` | a streaming-input session asked for a long essay, then `query.interrupt()` mid-stream, which stamps `aborted: true` |
| `session-messages.json` | `getSessionMessages(<the tool-turn session id>, {includeSystemMessages: true})` |
| `unknown-message.json` | a `rate_limit_event` frame from the plain run — a real member of `SDKMessage` |
| `streaming-turn.json` | one prompt with `includePartialMessages: true`, captured 2026-09-06 — the whole `stream_event` run of one turn, `message_start` through `message_stop` (#8172) |
| `thinking-turn.json` | excerpted from an operator's own CLI session transcript, not from a `query()` run — see below |
| `compact-boundary.json` | the same, from a session that compacted |
| `informational-notice.json` | the same, from a session that hit a usage limit |

## The three excerpted from a CLI session transcript

`thinking-turn.json`, `compact-boundary.json` and `informational-notice.json` did not come from a
`query()` run. No `query()` capture can force them: a provider decides whether a turn reasons, a
compaction happens only deep into a long session, and a usage-limit notice needs the limit. The
founder ruled the source on
[#8151](https://github.com/kamp-us/phoenix/issues/8151#issuecomment-5556626806) — an operator's own
Claude Code session log carries all three, at no spend.

Captured 2026-09-06 from local session transcripts written by CLI **2.1.207** (the thinking and
compaction rows) and **2.1.234** (the notice).

**The CLI's on-disk record is not the SDK's wire form, and the difference is not cosmetic.** It keys
camelCase (`sessionId`, `compactMetadata`, `requestId`), carries fields the SDK has no name for
(`parentUuid`, `isSidechain`, `cwd`, `gitBranch`, `version`, `slug`), and raises `system` subtypes of
its own the SDK never emits at all (`local_command`, `turn_duration`, `stop_hook_summary`,
`away_summary`, `api_error`). `getSessionMessages` re-keys it on the way out — the SDK bundle's own
row mapper reads `{type, uuid, session_id: row.sessionId, message, parent_tool_use_id,
parent_agent_id, timestamp}` — and drops `subtype` entirely, which is why a compaction frame cannot
reach this mapping down the history path at all.

So each of these three is **a real payload inside a re-keyed envelope**:

| Fixture | Verbatim from the capture | Re-keyed against `sdk.d.ts` at 0.3.259 |
|---|---|---|
| `thinking-turn.json` | the whole `message` body — the reasoning text, the block's key set, `usage`, `stop_reason`; this is the part `blocks.ts` reads, and it is byte-identical in both wire forms | `sessionId` → `session_id`, `requestId` → `request_id`, `parent_tool_use_id: null` added, CLI-only keys dropped |
| `compact-boundary.json` | every value under the metadata — `manual`, the token counts, the duration, the preserved-segment shape | `compactMetadata` → `compact_metadata` and each of its keys to the snake_case names `SDKCompactBoundaryMessage` declares; `cumulativeDroppedTokens` and `preCompactDiscoveredTools` dropped, since the SDK type declares neither |
| `informational-notice.json` | `content` and `level`, and the key set — the CLI record carries every required field `SDKInformationalMessage` declares (`type`, `subtype`, `content`, `level`, `uuid`, `session_id`) and neither of its two optional ones (`tool_use_id`, `prevent_continuation`) | `sessionId` → `session_id` only |

The claim each backs is therefore narrower than the golden captures': they prove this mapping reads
the real payload, not that the SDK emits exactly this envelope. `compact-boundary.json` is the
weakest of the three — its key names come from the type declaration rather than from a run —
and [#8038](https://github.com/kamp-us/phoenix/issues/8038)'s live capture is where that gets closed
alongside the subagent frames.

Sanitization is the same as everywhere else here: uuids, `msg_*` and `req_*` ids substituted
consistently, the thinking block's signature replaced with a short placeholder, and every CLI-only
field naming a machine or a checkout dropped rather than rewritten.

## The sidechain capture

`agent-a1b2c3d4e5f60718a.jsonl` and `agent-a1b2c3d4e5f60718a.meta.json` are one subagent's own
transcript, the pair `readSidechain` reads. They came off an operator's own CLI store — the same
source and the same founder ruling as the three excerpted fixtures above
([#8151](https://github.com/kamp-us/phoenix/issues/8151#issuecomment-5556626806)) — because no
`query()` run writes a sidechain file: the Agent tool has to spawn, and the file is the CLI's, not
the SDK's.

| | |
|---|---|
| Captured | 2026-09-07, from a session written by CLI **2.1.217** |
| Layout | `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl` beside `agent-<id>.meta.json` |
| Subagent | `agentType: "probe-plugin:probe-grep"`, `spawnDepth: 1` |
| Rows | 7: the operator's prompt, two thinking frames, two text frames, a `tool_use` and its `tool_result` |

Unlike the three above, **this pair is not re-keyed** — it is the CLI's own on-disk form, verbatim,
because that form is exactly what the reader under test takes. The re-key to the SDK's
`SessionMessage` is `sidechain.ts`'s job and is what the test exercises, so re-keying the fixture
would test nothing.

The whole meta file is golden: `{"agentType","description","toolUseId","spawnDepth"}`, which is
where a subagent's type is authoritative and where the spawning call's id lives. Sanitization is
the same as everywhere else here — every uuid, `msg_*`, `req_*` and `toolu_*` id substituted
consistently, the two thinking blocks' signatures replaced with a short placeholder, and the `cwd`
on every row rewritten to `/tmp/tuval-capture`. Nothing else was touched: `isSidechain`, `agentId`,
`parentUuid`, `attributionAgent`, the `usage` blocks and the tool error text are verbatim.

The capture's two thinking blocks carry an empty `thinking` string, so the mapping emits no
thinking item for them. That is the real payload, not a trim — a `thinking` item over a sidechain
file is still uncovered here and rides
[#8038](https://github.com/kamp-us/phoenix/issues/8038)'s live capture with the rest.

## What was sanitized, and what is golden

For the `query()` captures, the **key set and the field shapes are the golden part** and are
untouched. The three excerpted fixtures are re-keyed instead, exactly as the section above records —
their golden part is the payload inside that envelope, not the envelope. Substituted, in both
groups:

- every uuid, `toolu_*`, `msg_*` and `req_*` id, consistently, so a cross-reference that was real
  in the capture is still real in the fixture (a `tool_result` still names its `tool_use`);
- absolute paths, to `/tmp/tuval-capture` and `/home/user` — no operator path lands in the repo;
- `thinking` block signatures, to a short placeholder;
- the open-ended discovery lists on `init` (`tools`, `slash_commands`, `skills`, `plugins`,
  `agents`, `mcp_servers`, `capabilities`) trimmed to their first three entries. They are a
  machine's local configuration, not part of any shape this mapping reads.

Everything else — `stop_reason`, the `usage` and `modelUsage` blocks, `total_cost_usd`,
`is_error`, `subtype`, `aborted`, `tool_use_result` — is verbatim. `boundary.unit.test.ts` reds if
any operator path returns and if the fixture set loses a member.

## What is not captured

**A subagent's frames off the live stream.** Every `query()` capture here is a top-level run, so
`parent_tool_use_id` is `null` on all of them. `events.unit.test.ts` covers the non-null case by
stamping that one field over the golden `tool-turn` stream, which is a derived shape and says so at
the case. The sidechain pair above is the on-disk half of the same thing and is real, but it is the
CLI's file rather than the SDK's stream; forcing a streamed one needs a run that spawns the Agent
tool, so it is an operator act like every other capture below —
[#8038](https://github.com/kamp-us/phoenix/issues/8038) tracks taking it.

**A `redacted_thinking` block.** No local session log carries one, and nothing a run controls decides
whether the provider withholds a turn's reasoning. `events.unit.test.ts` covers it by swapping that
one block's `type` and payload field over the golden `thinking-turn` frame, and says so at the case.

## Re-capturing

There is no committed capture script: a run needs live credentials and writes real spend, so it is
an operator act, not a test fixture generator. To re-capture the `query()` fixtures, drive `query()`
from a scratch directory exactly as the first table describes, then apply the substitutions above
before the JSON comes anywhere near this directory.

The three excerpted fixtures cannot be re-produced that way — no `query()` run forces reasoning, a
compaction or a usage-limit notice. Re-producing them means finding the frame again in an operator's
own local CLI session log and re-keying it against `sdk.d.ts` at the catalog pin, per the table in
[the section above](#the-three-excerpted-from-a-cli-session-transcript). Replacing them with real
`query()` captures is [#8038](https://github.com/kamp-us/phoenix/issues/8038)'s live capture run,
which is where `compact-boundary.json`'s declaration-derived key names get closed.
