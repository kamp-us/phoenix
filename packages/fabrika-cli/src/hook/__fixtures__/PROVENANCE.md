# Capture provenance — the two golden hook envelopes beside this file

ADR [0180](../../../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md) makes the
captured payload the only ground truth for anything the runtime emits, and this file is what lets a
reviewer tell a captured payload from a hand-authored one **without the authoring session**. Read it
before trusting either fixture; a fixture with no provenance beside it is an assertion, not evidence.

| Fixture | Harness event | Matcher |
| --- | --- | --- |
| [`session-start.payload.golden.json`](session-start.payload.golden.json) | `SessionStart` (`source: startup`) | — |
| [`pre-tool-use.payload.golden.json`](pre-tool-use.payload.golden.json) | `PreToolUse` | `Bash` |

**Captured:** 2026-08-09, against **Claude Code 2.1.226**.

**How:** one nested `claude -p` run against the live harness, with a throwaway `--settings` file whose
`hooks` block registered `{"type": "command", "command": "cat > <sink>"}` on `SessionStart` and on
`PreToolUse` (matcher `Bash`). The probe tool call was `echo capture-probe`. The bytes below each
fixture's first line are the raw stdin the harness wrote to that sink, byte for byte.

**Sanitization — one substitution, and only one.** The operator's home-directory segment inside
`transcript_path` is replaced with `<operator>`; nothing else was touched. That is the same, and the
only, edit the repo's prior captured fixture carries
([`../../../../pipeline-cli/src/tools/worktree-sweep/__fixtures__/worktree-create.payload.golden.json`](../../../../pipeline-cli/src/tools/worktree-sweep/__fixtures__/worktree-create.payload.golden.json)),
and it is required rather than cosmetic: no committed artifact in this repo carries a home,
machine-local or absolute operator path. The opaque per-session values (`session_id`, `prompt_id`,
`tool_use_id`) are the **real** captured ones and were deliberately left alone — they identify a
throwaway capture session in a temp directory and name no person or machine.

**Where the record lives:** the capture was posted to
[#5074](https://github.com/kamp-us/phoenix/issues/5074) (comment `5233372828`) before either fixture
was written, so the raw envelope is readable outside this repo too.

**What is golden here, and what is not.** The golden part is the **key set** — which keys the harness
sends and which it does not. `PreToolUse` carries `prompt_id`, `permission_mode` and `effort`, none of
which the hand-authored envelope in v1's spawn-guard test knew about; `SessionStart` carries `source`
and carries **no** `tool_name`, `tool_input` or `prompt_id`. Those presences and absences are what
[`../envelope.golden.test.ts`](../envelope.golden.test.ts) pins. The values are illustrative.

**The limit, stated rather than implied.** These fixtures freeze what 2.1.226 emitted on one machine
on one day. Nothing in this repo can detect the harness changing its envelope — no gate executes the
real harness (ADR 0180's own premise). A test over a stale fixture goes green. Re-capture, by the
method above, is the only way to refresh it, and a re-capture updates this file in the same commit.
