# Spawn scope — which agents a seat may spawn, and why it is a charter rule

The roster law (ADR [0189](../../.decisions/0189-crew-roster-law-bridges-engines.md)) keeps the
build drain on the **engine** and off the **bridges**: a bridge conducts its own seam and fans
read-only investigations (ADR [0196](../../.decisions/0196-read-only-crew-fanout.md)), it never
runs `coder → reviewer → shipper`. **This doc is the single source for how that line is held.**
Each crew def states its own one-line spawn scope and cites this file; none of them re-derive the
reasoning inline.

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

**Both rules bind the whole roster, not just the launched seats.** They are declaration rules for
*every* def the crew ships — the crew seats here **and** the kampus-pipeline subagent defs under
[`../kampus-pipeline/agents/`](../kampus-pipeline/agents/) (`coder`, `reviewer`, `shipper`,
`planner`, `canon`, `adr`, `triager`, `reporter`). `toolset-assert.ts` only *enforces* them for the
seats the launcher launches; **no launcher spawns the subagent defs**, so nothing mechanically
catches a phantom `Grep`/`Glob` there — the rule itself is the guard. Every subagent def carried the
same phantom `Grep`/`Glob` silent-drop as the seats did (#3782, the subagent half of #3764); when
authoring or editing one, keep its `tools:` to what the CLI actually grants (`Read`, `Edit`,
`Write`, `Bash`, and any `mcp___…` tool), never `Grep`/`Glob`.
