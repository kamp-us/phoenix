# Provenance — Claude Agent SDK message fixtures

Captured from real runs, per
[`.patterns/golden-real-payload-fixtures.md`](../../../../../../.patterns/golden-real-payload-fixtures.md)
and ADR [0180](../../../../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md).
Nothing here is hand-authored: the SDK's message shapes are observable only at execution, so an
invented envelope would prove the mapping against a contract nobody emits.

Most of them came off `query()`. Six did not, because no `query()` run can force what they carry;
they were excerpted from an operator's own CLI session log and re-keyed to the SDK's declared
envelope, and the two sections below say exactly which part of each is the captured part.

## What produced them

The rows below describe the `query()` captures; the six excerpted fixtures have their own sections.

| | |
|---|---|
| Captured | 2026-09-04; `streaming-turn.json` on 2026-09-06; `subagent-turn.json` and `two-subagent-turn.json` on 2026-09-07 |
| SDK | `@anthropic-ai/claude-agent-sdk` **0.3.259** (the `pnpm-workspace.yaml` catalog pin) |
| CLI | `claude_code_version` **2.1.259**, as reported by the `init` frame itself |
| Models | `claude-fable-5-1` on every capture but `interrupted-assistant.json` and `subagent-turn.json`, which are `claude-opus-5` |

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
| `subagent-turn.json` | one prompt asking for a single `Task` spawn, run with `forwardSubagentText: true` and `includePartialMessages: true` on `claude-opus-5` with `thinking: {type: "enabled", budgetTokens: 8000}`, captured 2026-09-07 — the whole 74-frame run of a turn that spawns one worker (#8403) |
| `two-subagent-turn.json` | the same options on `claude-fable-5-1`, with a prompt asking for **two** `Explore` workers in parallel over two files in the throwaway cwd, captured 2026-09-07 — the whole 59-frame run, and the one capture where two workers overlap (#8408) |
| `local-command-turn.json`, `local-command-lines-turn.json`, `local-command-caveat-turn.json` | excerpted from an operator's own CLI session transcript, from sessions where a slash command ran — see below |
| `thinking-turn.json` | excerpted from an operator's own CLI session transcript, not from a `query()` run — see below |
| `compact-boundary.json` | the same, from a session that compacted |
| `informational-notice.json` | the same, from a session that hit a usage limit |

### The two-worker capture

`two-subagent-turn.json` is the capture `subagent-turn.json` could not be: **two workers running at
once**, which is the whole subject of the running list. The frames say so on their own — both
`Agent` calls are made and both raise `system`/`task_started` before either worker's
`tool_result` arrives, and the two results land four frames apart, so there is a stretch where one
worker finishes while the other is still writing. The run's own `result` frame agrees:
`subagent_stats` reads `{"spawned": 2, "completed": 2, "by_type": {"Explore": 2}}`.

That gap between the two endings is what `../../proof/subagent-vertical.integration.test.ts` replays
a frame at a time: it is the only moment at which a worker can finish while an operator is inside
its view (founder ruling Q9 on #8384).

The run was driven exactly as the first table's rows were — `query()` from a throwaway cwd holding
two one-line files, every message the iterator yielded written in order — and sanitized the same
way, plus two shapes the other captures do not carry: the CLI's slug-encoded project key (a temp
path with the separators rewritten), and a path split across four `input_json_delta` frames.

**The split path is the one that went wrong, and it is worth reading before taking another
capture.** The first pass substituted the delta holding the absolute prefix and left the neighbour
holding the rest of it, so the fixture kept a bare tail of the operator's temp namespace — matching
no root name, invisible to a scan for absolute prefixes, and outside `leak-guard`'s surface, which
does not read `.json`. It was caught in review of #8474 and the frames were rewritten so the run
reassembles to the same path the settled block carries. The split itself is kept, cut mid-token
where the capture cut it: it is the shape a sanitizer has to survive, and the corpus should hold one.

The check that now stands behind that is in `../boundary.unit.test.ts`: it reassembles every
`input_json_delta` run in every fixture and compares it to the `tool_use` block that settles it, so
a capture whose two halves disagree reds. That is a narrow guarantee and the section below says how
narrow.

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

## The three local-command captures

`local-command-turn.json`, `local-command-lines-turn.json` and `local-command-caveat-turn.json` are the same kind of excerpt as the
three above, under the same founder ruling
([#8151](https://github.com/kamp-us/phoenix/issues/8151#issuecomment-5556626806)), and for the same
reason: a slash command is the CLI's, so no `query()` run can produce one. Both are the record of a
command the operator ran — `/model` and `/terminal-setup` — and both are why #8211 exists: the CLI
writes a command's result as a **user-role** message whose whole text is a
`<local-command-stdout>` wrapper, which the mapping read as an operator turn.

| | |
|---|---|
| Captured | 2026-09-08, from local session transcripts written by CLI **2.1.218** (the `/model` result) and **2.1.170** (the `/terminal-setup` one) |
| Verbatim | the whole `message` body — the role and the wrapped text, terminal colour escapes included — and each row's own `timestamp` |
| Re-keyed | `sessionId` → `session_id`, `parent_tool_use_id`/`parent_agent_id` added as `null`, and the CLI-only keys (`parentUuid`, `promptId`, `cwd`, `gitBranch`, `version`, `userType`, `entrypoint`, `isSidechain`) dropped |

The escapes are the golden part of the first one, not noise a sanitizer missed: `/model` writes SGR
runs around the model's name, and stripping them is the mapping's job (`../map.ts`), so a fixture
without them would prove nothing about the line a reader sees. The second is the multi-line case —
three lines, so the notice's summary line is not its whole output — and it is what pins the detail
half of the row.

Sanitized as everywhere else here: the uuid and session id substituted. No row carries a path.

### The caveat frame

`local-command-caveat-turn.json` is the *other* user-role frame one slash command writes — the
caveat the CLI puts ahead of the command's output, which #8211 left as a YOU row and #8641 drops.

| | |
|---|---|
| Captured | 2026-09-08, from a local session transcript written by CLI **2.1.220**, the row timestamped `2026-07-25T23:22:33.911Z` |
| Verbatim | the whole `message` body — the role and the wrapped text, character for character — and the row's own `timestamp` |
| Re-keyed | `sessionId` → `session_id`, `parent_tool_use_id`/`parent_agent_id` added as `null`, and the CLI-only keys (`parentUuid`, `promptId`, `isMeta`, `cwd`, `gitBranch`, `version`, `userType`, `entrypoint`, `isSidechain`) dropped |

The dropped `isMeta: true` is the one worth naming: the CLI record carries it on this row and
`getSessionMessages` does not re-key it, so it is not a field the mapping can read down the history
path. `../map.ts` matches the tag instead, and this fixture is what holds it to that.

The text is the golden part and it is fixed boilerplate — the same sentence on every occurrence, so
this one row stands for all 1,774 of them in the corpus it was counted in. Sanitized as everywhere
else here: the uuid and session id substituted. The row carries no path.

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

The capture's two thinking blocks carry a signature and an empty `thinking` string. That is the real
payload, not a trim, and it is what a worker's reasoning looks like at this pin — `subagent-turn.json`
carries the same shape off the live stream. `blocks.ts` reads it as withheld, so each one is a
thinking item whose text says the provider withheld it. A `thinking` block with *plaintext* over a
sidechain file is still uncovered here and rides
[#8038](https://github.com/kamp-us/phoenix/issues/8038)'s live capture with the rest.

## What was sanitized, and what is golden

For the `query()` captures, the **key set and the field shapes are the golden part** and are
untouched. The six excerpted fixtures are re-keyed instead, exactly as the two sections above
record —
their golden part is the payload inside that envelope, not the envelope. Substituted, in both
groups:

- every uuid, `toolu_*`, `msg_*` and `req_*` id, consistently, so a cross-reference that was real
  in the capture is still real in the fixture (a `tool_result` still names its `tool_use`);
- absolute paths, to `/tmp/tuval-capture` and `/home/user`, in every form the path appears in —
  including the CLI's slug-encoded project keys and a path split across streamed deltas;
- `thinking` block signatures, to a short placeholder;
- the open-ended discovery lists on `init` (`tools`, `slash_commands`, `skills`, `plugins`,
  `agents`, `mcp_servers`, `capabilities`) trimmed to their first three entries. They are a
  machine's local configuration, not part of any shape this mapping reads.

Everything else — `stop_reason`, the `usage` and `modelUsage` blocks, `total_cost_usd`,
`is_error`, `subtype`, `aborted`, `tool_use_result` — is verbatim.

`subagent-turn.json` was re-sanitized in the same round: its `init` frame's `memory_paths.auto`
still carried the operator's temp namespace slug-encoded, which is the second of the two shapes the
widened scan below now names. Nothing else about that capture changed.

**What `../boundary.unit.test.ts` actually checks, which is less than "no operator path returns".**
Three things: that the fixture set has not lost a member; that no file carries either operator root
— `Users` or `var/folders` — in any of eight forms, being each root with its leading separator or
without it, spelled with slashes or slug-encoded the way the CLI keys a project directory, and with
`private` present or absent on the second; and that every streamed tool call reassembles to the
input its settled block carries. The eight forms are enumerated as their own case in that file, so
this list and the pattern cannot drift apart.

**A path fragment cut past both root names matches neither root check.** It carries no root name, so
there is nothing for that scan to match and no widening of it would help. That is exactly what the
`two-subagent-turn.json` split delta was, and the reassembly check is the only one that catches the
shape — and only where the fragment sits in a delta run with a settled block to disagree with. So
these checks are a net with a known mesh, not a proof: **read a new capture yourself before
committing it**, and treat them as what stops a shape that has already happened from happening
twice.

## What is not captured

**A `conversation_reset` frame.** Forcing one means sending `/clear`, exiting plan mode or starting a
fresh session against a live CLI — an operator run with real credentials and real spend, which is not
something a cold builder has (#8197). So no fixture here holds one, and
`../../agent/conversation-reset.unit.test.ts` builds the frame from `sdk.d.ts`'s
`SDKConversationResetMessage` at the pin instead — `type`, `new_conversation_id`, `uuid`,
`session_id`, and nothing else — and says so in its own docblock. Every other frame those cases use
is a capture from this directory. Replacing the derived frame with a real capture is
[#8197](https://github.com/kamp-us/phoenix/issues/8197)'s open evidence, and it belongs to the same
live capture run as the three excerpted fixtures above.

**A subagent's streamed reply.** The live-stream gap this section used to name is closed from both
ends now: `subagent-turn.json` is the SDK's stream — a worker's `user`, `assistant` (prose and
reasoning) and tool frames all arrive parent-tagged on the parent session — and the sidechain pair
above is the CLI's on-disk half of the same conversation. What does *not* arrive is a nested
`stream_event`: every one of the 74 frames carries `parent_tool_use_id: null` on the streaming half,
so a worker's reply is forwarded whole rather than delta by delta and no run can force the streamed
case. `events.unit.test.ts` covers it by stamping that one field over the golden `streaming-turn`
stream, and says so at the case.

**Reasoning in plain text off a stream.** Both captures agree and neither has one:
`subagent-turn.json` carries two `thinking` blocks and the sidechain pair two more, every one with a
real `signature` and an empty `thinking` string — the provider ships reasoning encrypted, and its
two `thinking_delta` frames carry the empty string for the same reason. Four `query()` runs at this
pin (two models, two thinking budgets) produced no plaintext one, so `thinking-turn.json`'s shape is
not what a live stream yields today. `blocks.ts` reads the empty-with-signature shape as withheld,
which is what the captures forced.

`subagent-turn.json` is still the only capture whose *stream* reasons, and it is what
`events.unit.test.ts` folds for the withheld case. For the growing row (#8288) that file stamps
plaintext over those two `thinking_delta` frames and the `thinking` block of the `assistant` frame
that settles them, leaving every envelope, block boundary and arrival order the capture's — and says
so at the case.

**Two workers under one *parent* tool call.** Both captures spawn workers as siblings of each other.
A `Task` call made *by* a worker — `spawn_depth` above 1 — is uncaptured, and nothing a prompt
controls decides whether a worker delegates further.

**A run with `forwardSubagentText` off.** `subagent-turn.json` sets it, because the SDK forwards only
a worker's `tool_use`/`tool_result` blocks by default — "enough for a heartbeat counter"
(`sdk.d.ts`, `Options.forwardSubagentText`). Tuval's own option builder does not set it yet
([#8427](https://github.com/kamp-us/phoenix/issues/8427)), so a live desk sees fewer nested frames
than this fixture holds.

**A `redacted_thinking` block.** No local session log carries one, and nothing a run controls decides
whether the provider withholds a turn's reasoning. `events.unit.test.ts` covers it by swapping that
one block's `type` and payload field over the golden `thinking-turn` frame, and says so at the case.

## Re-capturing

There is no committed capture script: a run needs live credentials and writes real spend, so it is
an operator act, not a test fixture generator. To re-capture the `query()` fixtures, drive `query()`
from a scratch directory exactly as the first table describes, then apply the substitutions above
before the JSON comes anywhere near this directory.

The six excerpted fixtures cannot be re-produced that way — no `query()` run forces reasoning, a
compaction, a usage-limit notice or a slash command. Re-producing them means finding the frame again
in an operator's own local CLI session log and re-keying it against `sdk.d.ts` at the catalog pin,
per the table in
[the section above](#the-three-excerpted-from-a-cli-session-transcript) or in
[the one after it](#the-three-local-command-captures). Replacing them with real
`query()` captures is [#8038](https://github.com/kamp-us/phoenix/issues/8038)'s live capture run,
which is where `compact-boundary.json`'s declaration-derived key names get closed.
