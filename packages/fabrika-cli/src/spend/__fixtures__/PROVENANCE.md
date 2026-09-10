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
