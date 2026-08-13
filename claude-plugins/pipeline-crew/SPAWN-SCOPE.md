# Spawn scope — which agents a seat may spawn, and why it is a charter rule

The roster law (ADR [0189](../../.decisions/0189-crew-roster-law-bridges-engines.md)) keeps the
build drain on the **engine** and off the **bridges**: a bridge conducts its own seam and fans
read-only investigations (ADR [0196](../../.decisions/0196-read-only-crew-fanout.md)), it never
runs `coder → reviewer → shipper`. **This doc is the single source for how that line is held.**
Each crew def states its own one-line spawn scope and cites this file; none of them re-derive the
reasoning inline.

## The one scoped exception: the intake-desk's plan gate (founder directive, 2026-07-29)

The intake-desk conducts the **plan-layer gate** over an epic ledger it had planned — the closing
step of planning, not an entry into the build drain. The four PR-stage gates (`review-code`,
`review-doc`, `review-skill`, `review-design`) plus `coder` and `shipper` remain the engine's seam,
and no bridge gains `reviewer`.

The line the roster law draws is still intact, because a plan-layer gate routes nothing: ADR 0189
forbids a bridge holding an **execution-routing** edge, and a gate fired over a planned ledger
hands no work to an engine — a flipped child becomes pickable off the board, exactly as a
`triage`-produced one does. ADR [0047](../../.decisions/0047-review-plan-gate.md) constrains the
gate's *shape* (it signals, it never repairs) and names no dispatcher; the gate runs in a
separately dispatched subagent that reads the epic and its children cold, so its independence comes
from that isolation, not from which seat fired it. The engine, by contrast, is structurally
disqualified: it consumes triaged children, it cannot produce them.

**Both halves of that seam now run fabrika, so neither `planner` nor `reviewer` is dispatched at
all.** The desk dispatches `claude-plugins/fabrika/skills/plan-epic/` to write a ledger and
`claude-plugins/fabrika/skills/check-epic-plan/` to gate it, each as a fixed template handed to a
fresh general-purpose subagent — because a fabrika child is born carrying its `ready-for:` audience
(`fabrika ledger child` refuses the create without one, #4780) while a v1-planned child is not, and
an audience-less child is invisible to every engine's picker (#5462). The v1 defs are left
byte-unchanged and merely unrouted (ADR
[0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)).

The guard's tables still list `planner` and `reviewer` as sanctioned for the intake-desk. That is a
**permissive superset**, not a contradiction: the tables state which spawns would not be a charter
violation, and a seat is free to be narrower than its allowlist. They live in `packages/pipeline-cli/`
and are deliberately untouched here.

Because the guard below classifies per agent-type and not per skill, the plan-layer scoping lives in
the intake-desk's charter prose — including the two fixed dispatch templates it must use — and the
guard carries only the agent-type. See
[`agents/crew-intake-desk.md`](agents/crew-intake-desk.md).

## The line is a charter rule, not a permission mechanism (#3764)

The defs used to carry `disallowedTools: ["Task(coder)", "Task(reviewer)", …]` and describe it as
the permission engine hard-blocking those spawns. **That mechanism does not exist**, and the
declaration was actively harmful. Established against the installed CLI by booting probe agent-defs
and reading the `init` event's granted `tools`:

- An agent-def `disallowedTools` entry is matched by its **base tool name**; the `(specifier)` is
  **ignored**, and the **whole tool** is subtracted from that def's `tools:` allowlist. So
  `disallowedTools: ["Task(coder)"]` never denied the `coder` subagent — it deleted `Task`.
- A `permissions: { deny: [...] }` key in an agent def does not block the spawn either, under any
  token spelling (`Task(x)`, `Task(<plugin>:x)`, `Agent(x)`, `Agent(<plugin>:x)`).

The consequence was the live defect: all three bridge seats booted with **no `Task` at all**, so
the intake-desk could not discharge its charter obligation to spawn the `planner` over a triaged
epic, and no seat could reach the ADR 0196 read-only fanout. The restriction meant to scope a
bridge's spawns had instead removed every spawn it was supposed to keep.

So the scope is stated where a seat actually reads it — **its own charter prose** — and the
platform grants `Task` at whole-tool granularity, which is the only granularity it offers. A seat
that spawns outside its stated scope is violating its charter, the same way it would by
implementing a ticket or merging a PR; nothing below the model enforces it.

## What keeps the scope from silently going unstated

`pipeline-cli crew-fanout-guard check` (CI) owns the per-bridge classification: every mutating
agent-type in the roster must be on a bridge's sanctioned allowlist **or** its explicit
out-of-scope list, both in
[`packages/pipeline-cli/src/tools/crew-fanout-guard/crew-fanout-guard.ts`](../../packages/pipeline-cli/src/tools/crew-fanout-guard/crew-fanout-guard.ts).
A newly-added agent-type on neither reds the build (ADR 0092). That is a completeness check on the
*policy*, not an enforcement of it — it guarantees the line is always stated, never that it is
obeyed.

## What keeps a declared toolset from silently shrinking

The CLI drops a tool name it cannot grant **with no warning**, which is why the `Task` loss ran a
whole session unnoticed. The launcher now refuses a stand-up (or an on-demand `spawn-role`) whose
seat def declares a toolset the CLI would not resolve intact —
[`packages/pipeline-crew-mcp/src/standup/toolset-assert.ts`](../../packages/pipeline-crew-mcp/src/standup/toolset-assert.ts),
which also carries the re-derivation command for the grantable tool set on a CLI version bump.

Two rules it enforces, both worth knowing when editing a def:

- Do not name a tool in **both** `tools:` and `disallowedTools:` — the second deletes the first.
- Do not declare `Grep` or `Glob`. They are not tools a top-level session is granted; `Bash` covers
  those reads.
