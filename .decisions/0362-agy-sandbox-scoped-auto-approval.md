---
id: 0362
title: Tuval's agy backend runs sandboxed with sandbox-scoped auto-approval, never blanket bypass
status: accepted
date: 2026-09-06
tags: [tuval, ai-agent, agy, permissions, sandbox]
---

# 0362 — Tuval's agy backend runs sandboxed with sandbox-scoped auto-approval, never blanket bypass

**What this decides:** the `agy-session` row launches `agy` under its own sandbox with tool calls auto-approved inside that sandbox and no blanket permission bypass, it renders no permission card, and this record states the two things `agy`'s documentation promises about that sandbox which were measured false.

**This record's decision, and the `step_type` / `result` census it rests on, are scoped to `agy` v1.1.27 on macOS.** Later-version measurements are each named for the version they were taken against where they land — inline in a correction, as the `SIGINT` and `result.usage` re-measurements at v1.1.28 are, or in a section of their own, as `error_message` at v1.2.0 is — rather than folded back into that pin, under the rule `## Grounding` states. The pin is load-bearing rather than decorative: the stream `agy` emits carries no protocol version and no schema version field of any kind, so a consumer has nothing to negotiate against and nothing that would tell it the shape changed. `result.denied_actions` was added one release before the spike that produced this record, which is how fast the surface moves. A reader on a later version is holding a partly-unverified document — what a named section measured against their version holds there, and the rest is unverified rather than stale.

**v1.1.27 is the supported floor, not the one supported release.** The founder ruled it on [#9191](https://github.com/kamp-us/phoenix/issues/9191#issuecomment-5673883768) after every hand-verification in that batch ran on a newer binary and passed: `apps/tuval/src/agy/preflight.ts` now runs `agy --version` before a session opens, refuses below this pin with the floor and the version read named, and announces what it read so every hand-verification and bug report carries it. That changes what the pin *supports* and nothing about what it *measures* — the rule `## Grounding` states is untouched, so a claim in this record still holds only for the version it was measured against, and a reader above the floor is still holding a partly-unverified document.

## Context

Tuval ships two `TuvalAiAgent` backends today, `apps/tuval/src/pi/` and `apps/tuval/src/claude/`. [#8162](https://github.com/kamp-us/phoenix/issues/8162) adds `agy` (the Antigravity CLI) as a third, and the permission question had to be settled before that adapter could be written, because `agy` cannot be driven the way the other two are.

Headless `agy` prompts for tool permissions on `/dev/tty` only. Driven by Tuval there is no TTY, so it cannot ask, and it auto-denies with:

> `a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied`

So the backend either runs with permissions pre-settled at launch or it does nothing at all. That is not a free choice: `apps/tuval/src/claude/config.ts` fixes the Claude row's mode list to four and refuses `bypassPermissions` and `dontAsk` on the grounds that the whole permission surface of this program is the card. A backend that can render no card is an exception to that rule, and an exception of that kind is a founder call rather than a builder's.

The founder ruled it on [#8179](https://github.com/kamp-us/phoenix/issues/8179), and this record transcribes that ruling: <https://github.com/kamp-us/phoenix/issues/8179#issuecomment-5556852675>.

## Decision

**The `agy-session` row runs sandboxed with sandbox-scoped auto-approval, and never with blanket bypass.**

The posture is three things together, and none of them is optional:

- `{"toolPermission": "proceed-in-sandbox"}` in `$HOME/.gemini/antigravity-cli/settings.json`.
- Launched with `--sandbox --add-dir=<repo>`.
- Launched **without** `--dangerously-skip-permissions`.

Under it, tool calls inside the sandbox auto-approve — the session's `init` event reads `permission_mode: proceed-in-sandbox` — while reads and writes outside the workspace are refused by macOS Seatbelt with `Operation not permitted`. That was measured against `$HOME`, against `$HOME/.zshrc`, and against sibling directories of the workspace.

**It fails closed, and that is the property that makes it defensible.** With the same `toolPermission` setting but `--sandbox` omitted, every tool is denied. The unsafe configuration is not reachable by dropping a flag or by a settings file drifting out from under a launch — losing the sandbox loses the auto-approval with it. Blanket bypass has no such property, which is why it was rejected rather than merely not chosen.

**`toolPermission` is the only key that moves `init.permission_mode`.** `permissionMode`, `permission_mode`, `defaultMode` and `autoExecutionPolicy` are the desktop application's proto field names; `agy` reads none of them from this settings file and reports no error when one is present. Bisected against v1.1.27. A reader who sets one of those four has configured nothing and has been told nothing, which is worse than an outright failure, so the four are named here rather than left to be rediscovered.

**`--add-dir=<repo>` is required.** Without it the sandbox hands the agent a cwd of `$HOME/.gemini/antigravity-cli/scratch`. Relative paths then resolve silently into that scratch directory, and `write_to_file` rejects real repository paths as `not a valid artifact path`.

**There is no permission card and no `answer` implementation.** Nothing ever asks, so there is nothing to answer: `TuvalAiAgentApi.answer` fails `UnknownRequest` on this backend. That is the honest reading of the posture rather than a degraded one — a card rendered here would be a card for a question the backend is structurally incapable of raising.

**Binding constraints.**

- `--dangerously-skip-permissions` is not a fallback for a workspace the sandbox refuses. A path the sandbox will not grant is a scope question for `--add-dir`, never a reason to remove the sandbox.
- `toolPermission: proceed-in-sandbox` is never set without `--sandbox` on the launch. The pair is the posture; either half alone is either useless (no sandbox flag: everything denied) or unconfigured (no setting: everything denied).
- No `answer` implementation is written for this backend on the theory that a future release might prompt. If a release starts prompting, that is a new measurement and a new record.

## The two guarantees the spike measured as FALSE

`agy`'s own documentation makes two claims about its sandbox that do not hold at v1.1.27. Both were measured, both contradict the vendor, and both are stated here because **a reader who inherits a false model of what this sandbox contains makes worse decisions than a reader with no model at all.**

**1. Network is unrestricted inside the sandbox.** The documentation states that sandboxed mode has no network access. Inside `--sandbox`, requests to `example.com` and to `api.github.com` both returned `200`. No allowlist was observed and no request was refused.

**2. `.git` is writable inside the sandbox.** The changelog states that the sandbox grants read-only access to `.git`. A clean single-command test in a fresh conversation wrote into `.git` on the first attempt.

**So what this sandbox contains is filesystem blast radius, and that is the whole of it.** It bounds where an agent can read and write on disk to the directories `--add-dir` granted. It does not contain data egress: anything the agent can read, it can send anywhere on the open network. It does not protect version-control history: the repository's own `.git` is writable from inside. Nothing in this record should be read as saying otherwise, and a downstream decision that treats this sandbox as a boundary against exfiltration is resting on a guarantee that was tested and did not hold.

## Four behaviours that are easy to mistake for bugs later

These shape how the adapter is written, and each of them looks like a defect the first time it is met.

**An interrupt is named at the wire, as `error: "interrupted"`.** `SIGINT` exits 1 and emits a well-formed terminal `result` event carrying `status: "ERROR"`, `response: ""` and `error: "interrupted"`; the child also writes `error: interrupted` to stderr. The string `INTERRUPTED` exists in the binary — it is extractable with `strings` — and never fires as a *status*, which is a separate claim and still holds. **Corrected:** this record originally read that `error` as `"timeout waiting for response"` and concluded the adapter could not tell a stop it asked for from a stall. Two independent measurements say otherwise — a scratch desk against v1.1.27, the version this record pins ([#8694](https://github.com/kamp-us/phoenix/issues/8694)), and a direct `SIGINT` probe of a `--input-format=stream-json` session against v1.1.28 — and both answered `{"status":"ERROR","response":"","error":"interrupted"}`. The original reading was taken from a one-shot `--print` run; whether the difference is the invocation shape or the original observation, the stream-json session the adapter actually runs names the stop, so the adapter reads it off the wire (`src/agy/ai-agent/mapper.ts`, which marks the cut reply `interrupted` rather than failing the turn) instead of inferring it.

This is about the *terminal event*, and it is a different proposition from the one ADR [0356](0356-tuval-interrupt-refusal-as-failure-tag.md) fences: 0356's refusal is the **interrupt call** being refused, and on this backend that call is a `kill` with `SIGINT`, which can fail. So this adapter has a refusal path, 0356's obligation binds it like its three peers, and it emits the interrupt-failure tag where it once logged a warning (`src/agy/ai-agent/refusals.ts`'s `interruptFailureOf`). The refusal is the one case the wire still answers nothing about — the signal never left this process, so no `result` is coming — which is why the `reason` that tag carries, `turn-running` or `no-live-turn`, is read off the layer's own memory of the send.

**The first write to a new path is denied and succeeds on retry.** The Seatbelt profile widens dynamically as the session runs, so a path that was outside it a moment ago is inside it after the denial. The cost is a wasted turn, and the real hazard is that a model reads the first denial as a settled refusal and gives up rather than retrying.

**`result.usage` is the conversation's running total, not the turn's.** A three-turn census reads `16771/1`, `21419/2`, `26280/3` in `result.usage.input_tokens`/`output_tokens` while those turns' own `agent_response` steps report `16771/1`, `4648/1`, `4861/1`: field by field the result restates every step in the *conversation*, including turns a resumed child never saw. It reads exactly like a per-turn total on a one-turn capture, which is how the adapter first folded it and how an operator's usage header came to double a turn it had already counted ([#8695](https://github.com/kamp-us/phoenix/issues/8695)). `result.num_turns` counts that conversation's turns and continues across a resume, and `step_index` likewise, so both are stable identities the ledger can key a report on.

**`result.denied_actions` is one release old.** It arrived in the release immediately before the version this record pins, so it is the newest field the adapter depends on and the first one to suspect if a different version behaves oddly.

## A later-version reading: `error_message` at v1.2.0

**This section is scoped to v1.2.0 and changes nothing above.** Per the grounding rule below, a measurement against a later version is named as such rather than written back onto the pin, so the five-value `step_type` census and every other v1.1.27 claim stand exactly as they read.

**v1.2.0 emits a sixth `step_type`, `error_message`, and it carries no text.** The step is `{"step_index":2,"state":"DONE","step_type":"error_message","duration_seconds":0}` — `text_delta` is absent, not empty — and the turn *continues* past it: the next `agent_response` is agy retrying the reply, and `result.num_turns` is still `1`. The message the step stands for rides the terminal `result.error` instead, and agy's on-disk transcript records it as the `SYSTEM`/`ERROR_MESSAGE` line the history reader already renders with its `content`.

**The trigger is agy's own abort, not the operator's stop.** It was first met on the interrupt path, which made "suppress it when the turn was interrupted" look like the whole fix ([#8896](https://github.com/kamp-us/phoenix/issues/8896)). Driving the real binary says otherwise: a prompt asking for a verbatim passage of a copyrighted novel trips the recitation filter and produces the step with no `SIGINT` anywhere, while eleven drives that included four `SIGINT` stops produced none at all. So the adapter recognises the step and lets the terminal event decide whether it is worth a row — dropped on a stop, where the cut reply's `interrupted` mark already says the same thing; rendered otherwise, where it is the only account of why the reply stopped (`src/agy/ai-agent/mapper.ts`).

**`AGY_VERSION` stays at `1.1.27`.** The constant names the release the whole `wire.ts` module was captured from, and one step type read on one later machine is not a re-census — moving it would restate the v1.1.27 capture as a v1.2.0 one, which is the laundering this record's own rule forbids. It moves when the module is captured again, and `src/agy/ai-agent/launch.unit.test.ts` moves with it.

## A later-version reading: `--effort` at v1.2.3

**This section is scoped to v1.2.3 and changes nothing above.** Per the grounding rule below, a measurement against a later version is named as such rather than written back onto the pin, so every v1.1.27 claim — the sandbox census, the four easy-to-mistake behaviours, the `step_type` set — stands exactly as it reads.

**v1.2.3 bakes reasoning effort into the model id, so `--effort` is no longer an independent axis.** The flag is accepted only when it repeats the suffix already in `--model`, and refused outright for a model whose id carries none. Both refusals are verbatim as measured:

```
$ agy --model gemini-3.1-pro-high --effort low --print='reply ok'
error: invalid model selection (--model "gemini-3.1-pro-high" --effort "low"): --model gemini-3.1-pro-high conflicts with --effort=low

$ agy --model claude-sonnet-4-6 --effort high --print='reply ok'
error: invalid model selection (--model "claude-sonnet-4-6" --effort "high"): --effort is not supported for model "claude-sonnet-4-6"
```

**`agy --print='/effort' --output-format=json` still answers `{"adjustable":true,"current":"high","available":["low","medium","high"]}`.** That is the v1.1.27 read the adapter's three-level catalog was built from, and it is the reason the drift was invisible: the CLI's own report of the axis outlived the flag's acceptance of it. A catalog read off that answer offers three levels of which at most one can launch, and on a Claude-family row none can.

**So the adapter drops the axis rather than deriving one.** The agy row publishes the resolved-empty thinking offer — `{current: null, available: []}`, which the composer already reads as `none offered` with the control disabled — refuses every `ThinkingLevel` with an empty `available`, and composes `--effort` on no launch path ([#9254](https://github.com/kamp-us/phoenix/issues/9254)). The family-grouping alternative, parsing the id suffix and composing a model id from a level, was considered and ruled out by the founder: it reads structure out of a naming convention agy does not declare, and the `(High)` / `(Medium)` / `(Low)` rows of the model catalog already give a window every level agy can actually be launched at.

**`AGY_VERSION` stays at `1.1.27`.** The constant names the release the whole `wire.ts` module was captured from, and this change re-captures no wire shape — it removes a launch flag and a catalog, neither of which is a wire reading.

## A later-version reading: the `write_file` allow-rule at v1.2.3

**This section is scoped to v1.2.3 and changes nothing above.** Per the grounding rule below, a measurement against a later version is named as such rather than written back onto the pin, so every v1.1.27 claim — the sandbox census, the four easy-to-mistake behaviours, the `step_type` set — stands exactly as it reads.

**v1.2.3 soft-denies every `write_file` this record's posture does not allow-list, and the denial does not lift on a retry.** Under `toolPermission: proceed-in-sandbox` plus `--sandbox --add-dir=<repo>`, reads and sandboxed commands are still auto-approved, but a write with no matching rule under `permissions.allow` is denied on the first attempt and on every retry in the same conversation. Headless runs print a stderr notice naming the rule, verbatim as measured:

```
a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. write_file(<target>))
```

The agy log says the same thing on each such run, in two lines:

```
CLI settings initialized: permissions=<nil>, toolPermission=proceed-in-sandbox
soft-denying tool confirmation "WriteToFile"
```

**The remedy is `"permissions": {"allow": ["write_file(*)"]}` in the settings file plus a fresh session.** agy reads settings once at launch, so a running child keeps denying after the file is edited; only the next launch reads `permissions=&{Allow:[write_file(*)] ...}`. The fail-closed property this record measured survives the rule: `rm -rf .git` stayed blocked by the sandbox and the escalation was denied.

**So the v1.1.27 reading "the first write to a new path is denied and succeeds on retry" does not hold at 1.2.3.** That claim stands above as the v1.1.27 measurement it is; on 1.2.3 the retry is denied identically, so the denial is a settings fact rather than a profile that widens. The row's preflight therefore reads the allow-rule beside `toolPermission` and refuses `start` with the rule in the message ([#9240](https://github.com/kamp-us/phoenix/issues/9240)), and the session note the adapter opens with names the rule instead of promising a retry.

**`AGY_VERSION` stays at `1.1.27`.** The constant names the release the whole `wire.ts` module was captured from, and this change re-captures no wire shape — it reads one more key out of a settings file and rewrites one system row.

## Grounding

Per [CLAUDE.md](../CLAUDE.md)'s rule that a decision-driving claim about a dependency's behaviour is verified against the authoritative source rather than asserted, every behavioural claim above traces to one of two things: a live run of `agy` v1.1.27 on macOS during the spike recorded on [#8162](https://github.com/kamp-us/phoenix/issues/8162), or a `strings` extraction from that binary (the `INTERRUPTED` status is the one claim from the latter). Where a claim contradicts the vendor's documentation, the measurement wins and the contradiction is named as such.

Two claims were re-measured after a hand-verification run of the adapter contradicted them, and both corrections above carry their own evidence: the `SIGINT` terminal event (a scratch desk against v1.1.27, plus a direct probe against v1.1.28) and the `result.usage` census (a three-turn stream-json session against v1.1.28, the third turn on a resumed child). A measurement against a *later* version is named as such rather than written back onto the pinned one; where the two agree, as they do on the interrupt string, the agreement is the point. The `error_message` section is that rule applied again, one minor further on: twelve drives of a v1.2.0 binary, the captured lines committed verbatim as `src/agy/ai-agent/fixtures.ts`'s `errorMessageStep` / `resultContentFiltered`, and the v1.1.27 census left standing. The `--effort` section is the same rule two minors further on: a five-row `--model` / `--effort` matrix driven against a v1.2.3 binary, its two refusal strings quoted as printed, and the v1.1.27 `/effort` answer recorded beside them rather than replaced by them. The `write_file` allow-rule section is that rule once more on the same minor: a bare-CLI reproduction 4/4 plus a two-turn `--input-format stream-json` session against a v1.2.3 binary, both `result`s carrying `denied_actions: [{"action":"write_file"}]`, agy's stderr notice and its two settings log lines quoted as printed, and the v1.1.27 denied-then-succeeds-on-retry claim left standing as the v1.1.27 measurement it is.

Every vendor path in this record is written relative to `$HOME` and resolved at runtime. No absolute machine-local path appears, so the document stays true on a machine other than the one the spike ran on.

## Consequences

The `agy` adapter can be built with its permission surface already settled: no card, no `answer`, one settings key and two launch flags.

The cost is that this record's value decays with each `agy` release and nothing in the stream will announce the decay. A reader on a later version treats every section above as a hypothesis to re-measure, not as a fact to rely on. That is the price of a dependency with no version field on its own wire.

## Records

no vocabulary impact
