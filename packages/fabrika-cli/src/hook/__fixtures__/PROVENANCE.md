# Capture provenance — the golden hook envelopes beside this file

ADR [0180](../../../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md) makes the
captured payload the only ground truth for anything the runtime emits, and this file is what lets a
reviewer tell a captured payload from a hand-authored one **without the authoring session**. Read it
before trusting any fixture here; a fixture with no provenance beside it is an assertion, not evidence.

| Fixture | Harness event | Matcher | Capture |
| --- | --- | --- | --- |
| [`session-start.payload.golden.json`](session-start.payload.golden.json) | `SessionStart` (`source: startup`) | — | [1](#capture-1--the-surface-envelopes) |
| [`pre-tool-use.payload.golden.json`](pre-tool-use.payload.golden.json) | `PreToolUse` | `Bash` | [1](#capture-1--the-surface-envelopes) |
| [`pre-tool-use-spawn.payload.golden.json`](pre-tool-use-spawn.payload.golden.json) | `PreToolUse` (a subagent spawn, `model: "opus"`) | `Task` | [2](#capture-2--the-spawn-envelopes) |
| [`pre-tool-use-spawn-unset-model.payload.golden.json`](pre-tool-use-spawn-unset-model.payload.golden.json) | `PreToolUse` (a subagent spawn, no model passed) | `Task` | [2](#capture-2--the-spawn-envelopes) |

**Sanitization — one substitution, and only one, in every fixture here.** The operator's
home-directory segment inside `transcript_path` is replaced with `<operator>`; nothing else is
touched. That is the same, and the only, edit the repo's prior captured fixture carried — v1's
`worktree-sweep` payload, deleted with that package (#6100) — and it is required rather than
cosmetic: no committed artifact in this repo carries a home,
machine-local or absolute operator path. The opaque per-session values (`session_id`, `prompt_id`,
`tool_use_id`) are the **real** captured ones and were deliberately left alone — they identify a
throwaway capture session in a temp directory and name no person or machine.

<a id="capture-1--the-surface-envelopes"></a>
## Capture 1 — the surface envelopes

**Captured:** 2026-08-09, against **Claude Code 2.1.226**.

**How:** one nested `claude -p` run against the live harness, with a throwaway `--settings` file whose
`hooks` block registered `{"type": "command", "command": "cat > <sink>"}` on `SessionStart` and on
`PreToolUse` (matcher `Bash`). The probe tool call was `echo capture-probe`. The bytes below each
fixture's first line are the raw stdin the harness wrote to that sink, byte for byte.

**Where the record lives:** the capture was posted to
[#5074](https://github.com/kamp-us/phoenix/issues/5074) (comment `5233372828`) before either fixture
was written, so the raw envelope is readable outside this repo too.

<a id="capture-2--the-spawn-envelopes"></a>
## Capture 2 — the spawn envelopes

**Captured:** 2026-08-09, against **Claude Code 2.1.226**.

**How:** two nested `claude -p` runs in a throwaway temp directory, each with its own `--settings`
file whose `hooks` block registered `{"type": "command", "command": "cat > <sink>; exit 2"}` on
`PreToolUse` with matcher `Task`. The `exit 2` blocks the spawn, so the envelope is captured without
the subagent ever running. Run 1's prompt asked for the `model` parameter `"opus"`; run 2's asked for
no model at all — the two branches the spawn decision has to tell apart.

**Where the record lives:** the raw bytes were posted to
[#5075](https://github.com/kamp-us/phoenix/issues/5075) (comment `5233974204`) before either fixture
was written.

**Two things this capture settles that a hand-authored envelope gets wrong.** A spawn's `tool_name`
is **`Agent`**, not `Task` — the matcher is `Task` and it fired, but the envelope says `Agent`, so a
guard filtering on `tool_name === "Task"` would never run. And the model arrives as the harness alias
**`opus`**, never the canonical `claude-opus-4-8` — which is the fact the alias map in
[`../../models.ts`](../../models.ts) exists for.

## What is golden here, and what is not

The golden part is the **key set** — which keys the harness sends and which it does not. `PreToolUse`
carries `prompt_id`, `permission_mode` and `effort`, none of which the hand-authored envelope in v1's
spawn-guard test knew about; `SessionStart` carries `source` and carries **no** `tool_name`,
`tool_input` or `prompt_id`; a spawn's `tool_input` carries `subagent_type` and `run_in_background`
beside the optional `model`. Those presences and absences are what
[`../envelope.golden.test.ts`](../envelope.golden.test.ts) pins. The values are illustrative — except
`tool_input.model`, whose alias spelling is itself part of what was captured.

## The limit, stated rather than implied

These fixtures freeze what 2.1.226 emitted on one machine on one day. Nothing in this repo can detect
the harness changing its envelope — no gate executes the real harness (ADR 0180's own premise). A test
over a stale fixture goes green. Re-capture, by the method above, is the only way to refresh it, and a
re-capture updates this file in the same commit.
