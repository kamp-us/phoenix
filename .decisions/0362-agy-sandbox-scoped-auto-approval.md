---
id: 0362
title: Tuval's agy backend runs sandboxed with sandbox-scoped auto-approval, never blanket bypass
status: accepted
date: 2026-09-06
tags: [tuval, ai-agent, agy, permissions, sandbox]
---

# 0362 — Tuval's agy backend runs sandboxed with sandbox-scoped auto-approval, never blanket bypass

**What this decides:** the `agy-session` row launches `agy` under its own sandbox with tool calls auto-approved inside that sandbox and no blanket permission bypass, it renders no permission card, and this record states the two things `agy`'s documentation promises about that sandbox which were measured false.

**Every claim in this record is scoped to `agy` v1.1.27 on macOS.** The pin is load-bearing rather than decorative: the stream `agy` emits carries no protocol version and no schema version field of any kind, so a consumer has nothing to negotiate against and nothing that would tell it the shape changed. `result.denied_actions` was added one release before the spike that produced this record, which is how fast the surface moves. A reader on a different version has an unverified document, not a stale one.

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

## Three behaviours that are easy to mistake for bugs later

These shape how the adapter is written, and each of them looks like a defect the first time it is met.

**An interrupt is indistinguishable from a timeout at the wire.** `SIGINT` exits 1 and emits a well-formed terminal `result` event carrying `status: "ERROR"` and `error: "timeout waiting for response"`. The string `INTERRUPTED` exists in the binary — it is extractable with `strings` — and never fires. The adapter cannot tell a stop it asked for from a stall, from the stream alone. ADR [0356](0356-tuval-interrupt-refusal-as-failure-tag.md) obliges an adapter whose backend can refuse an interrupt to emit the interrupt-failure tag; at this wire the refusal is not observable, so this backend has no refusal path to report and 0356 releases it. That is the fence holding, not a gap.

**The first write to a new path is denied and succeeds on retry.** The Seatbelt profile widens dynamically as the session runs, so a path that was outside it a moment ago is inside it after the denial. The cost is a wasted turn, and the real hazard is that a model reads the first denial as a settled refusal and gives up rather than retrying.

**`result.denied_actions` is one release old.** It arrived in the release immediately before the version this record pins, so it is the newest field the adapter depends on and the first one to suspect if a different version behaves oddly.

## Grounding

Per [CLAUDE.md](../CLAUDE.md)'s rule that a decision-driving claim about a dependency's behaviour is verified against the authoritative source rather than asserted, every behavioural claim above traces to one of two things: a live run of `agy` v1.1.27 on macOS during the spike recorded on [#8162](https://github.com/kamp-us/phoenix/issues/8162), or a `strings` extraction from that binary (the `INTERRUPTED` status is the one claim from the latter). Where a claim contradicts the vendor's documentation, the measurement wins and the contradiction is named as such.

Every vendor path in this record is written relative to `$HOME` and resolved at runtime. No absolute machine-local path appears, so the document stays true on a machine other than the one the spike ran on.

## Consequences

The `agy` adapter can be built with its permission surface already settled: no card, no `answer`, one settings key and two launch flags.

The cost is that this record's value decays with each `agy` release and nothing in the stream will announce the decay. A reader on a later version treats every section above as a hypothesis to re-measure, not as a fact to rely on. That is the price of a dependency with no version field on its own wire.

## Records

no vocabulary impact
