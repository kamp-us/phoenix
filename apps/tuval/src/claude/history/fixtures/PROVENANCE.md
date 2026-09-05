# Provenance — Claude Agent SDK message fixtures

Captured once from real `query()` runs against the live Agent SDK, per
[`.patterns/golden-real-payload-fixtures.md`](../../../../../../.patterns/golden-real-payload-fixtures.md)
and ADR [0180](../../../../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md).
Nothing here is hand-authored: the SDK's message shapes are observable only at execution, so an
invented envelope would prove the mapping against a contract nobody emits.

## What produced them

| | |
|---|---|
| Captured | 2026-09-04 |
| SDK | `@anthropic-ai/claude-agent-sdk` **0.3.259** (the `pnpm-workspace.yaml` catalog pin) |
| CLI | `claude_code_version` **2.1.259**, as reported by the `init` frame itself |
| Models | `claude-fable-5-1` on every capture but `interrupted-assistant.json`, which is `claude-opus-5` |

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
| `unknown-message.json` | a `rate_limit_event` frame from the plain run — a real member of `SDKMessage` this mapping has no shape for |

## What was sanitized, and what is golden

The **key set and the field shapes are the golden part** and are untouched. Substituted:

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

## Re-capturing

There is no committed capture script: a run needs live credentials and writes real spend, so it is
an operator act, not a test fixture generator. To re-capture, drive `query()` from a scratch
directory exactly as the table above describes, then apply the substitutions above before the JSON
comes anywhere near this directory.
