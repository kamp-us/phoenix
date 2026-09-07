# Agent shells

An **agent shell** is a behaviour-free agent definition under
[`../agents/`](../agents/) whose only job is to be a spawn target with a fabrika skill already
loaded. It is not a UI `Shell` component — that word is usually already taken in a product's own
prose, so this surface is always written **agent shell** in full.

A shell holds three things and nothing else, over the `name:` that is its address: a `skills:`
preload naming the one plugin-namespaced skill it exists to run, a `tools:` set scoped to what that
skill actually calls, and a `description:` saying when to spawn it. `model:` is the one optional
field (see below). All judgement — every step, rubric, acceptance test and terminal token — lives
in the preloaded skill, which is the surface the eval bar gates.

**No shell pins `effort:`, and no driver passes one when spawning a shell.** An omitted field
inherits the spawning session's effort, which is what a human naming the run should control.

**A shell that grows opinions is a defect** — anything a shell should "always do" belongs in its
skill, never in the shell body.

## A shell's name is a noun

**Name a shell for the thing that acts, never for the act**: `builder`, `reviewer`, `shipper`,
`operator`. A shell named for the act collides with the skill it loads and with every other
definition that performs it, and the collision is invisible until two definitions contend for one
address.

**The address is the bare noun.** A driver spawns `reviewer`, not `fabrika:reviewer` — the
qualified spelling names the plugin's shell in prose. The platform mechanism is that a bare `name:`
becomes the definition's `agentType` verbatim, and the plugin-qualified form does not resolve; the
only proof of which form resolves in a given harness is spawning it.

## No `memory:`

No shell declares `memory:` in any form. Repo knowledge belongs in the host repository's own pattern
docs, where every session reads it, not in a per-shell store only that shell can see.

## The model a shell runs on

**Nothing enforces it.** The `PreToolUse` hook that denied an off-allowlist spawn is retired: which
model a subagent runs on is a per-run human choice, named at the spawn, and a hook that second-
guesses it only blocks the choice the human already made.

Every shell leaves `model:` unset, so a spawn inherits the caller's model unless the caller names
one. [`packages/fabrika-cli/src/models.ts`](../../../packages/fabrika-cli/src/models.ts) is still
the house vocabulary — the canonical ids and their harness aliases.

## Which shells carry a spawn tool

Every shell does. Each definition declares the harness spawn tool, `Agent`, in `tools:`. The grant
is baseline: a new shell declares `Agent` at creation. Read `tools:` in
[`../agents/`](../agents/) for what a shell carries, not this page — the definitions are the
statement.

The grant is not decorative for the operator: every route in the operate loop
([`../skills/operate/SKILL.md`](../skills/operate/SKILL.md)) is itself a spawn of another shell, so
an operator without it can dispatch nothing.

A spawn tool is not a `Skill` grant: `shipper` holds none — the ship skill routes by writing a
ship note and stopping.

Write the tool's canonical name, `Agent` — the `name` on the spawn tool in the Claude Code 2.1.233
bundle, which also carries `aliases: ["Task"]`. Both strings grant the tool; `Agent` is the house
choice. An unrecognised `tools:` entry drops silently — no warning, no non-zero exit — so a grant
is proven by spawning, not by the file parsing.

## Fields a plugin-scope shell may not use

`permissionMode:`, `hooks:` and `mcpServers:` are dropped for plugin-scope agent definitions with
a load-time warning (`…, which is ignored for plugin agents. Use .claude/agents/ for this level of
control.`, read out of Claude Code 2.1.233). None of the three appears on any shell.
