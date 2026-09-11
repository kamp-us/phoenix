# Codex hook capture

`codex-session-start.payload.golden.json` is a native Codex CLI 0.154.0 SessionStart
capture taken on 2026-09-10. It is not a constructed event.

The capture used a temporary Codex home and a command hook that copied stdin to a file.
The exact command was reviewed and trusted through the native `/hooks` UI. An app-server
client initialized the connection, started an empty thread, then submitted its first turn.
The runtime emitted SessionStart to the command. The hook returned `continue: false`
after saving stdin, stopping the turn before inference. No agent did delegated work.
No global config was changed and no trust bypass flag was used.

Sanitization replaced only `session_id`, `transcript_path` and `cwd` with fixed placeholders.
All seven keys and the other values remain as emitted. In particular, this startup input has
no `turn_id`, `tool_name` or `tool_input`. The fixture does not claim to capture those events.
The observed `permission_mode` is retained as runtime evidence, not a requested setting.

[codex-hook.golden.test.ts](../codex-hook.golden.test.ts) loads the captured bytes through
`readGoldenFixture`, substitutes only temporary filesystem paths, and runs `runCodexHook`.
Its separate minimal transcript and dispatch binding are constructed test setup. The test
proves native startup handling and explicit missing-response coverage without an invented
turn. It runs in the required package test job. The other Codex tests remain constructed
counter, descendant, retry and recovery scenarios; this capture does not relabel them.

## Native usage capture

`codex-token-usage.golden.jsonl` contains three rows selected from an existing completed
Codex CLI 0.154.0 session on 2026-09-10. No new model call was made for this evidence.
The session contained 43 native usage rows. The fixture retains its first usage row,
the owning session metadata and that turn's model context.

Sanitization consistently replaced opaque identity strings and removed prompts, outputs,
environment fields and filesystem paths. The retained timestamps, ordinals, outer row
types, usage payload keys and all three counter objects are unchanged. In particular,
usage is a top-level `token_usage_record`, with no `payload.type`. Its response reports
22039 input, 12160 cached input, zero cache writes, 109 output, zero reasoning and
22148 total tokens.

[codex-usage.golden.test.ts](../codex-usage.golden.test.ts) loads these bytes unchanged
and executes the real hook against the file. The callback and binding commands are
constructed setup, not captured hook inputs. The test asserts persisted counters,
response and cumulative separation, unknown issue retention, resolution and replay
without duplicate responses. It runs in the required package test suite. The separate
SessionStart fixture above proves the startup input contract only.
