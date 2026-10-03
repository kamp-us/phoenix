# Agent shells

An **agent shell** is a behaviour-free agent definition under
[`../agents/`](../agents/) whose only job is to be a spawn target with a fabrika skill already
loaded. It is not a UI `Shell` component — that word is usually already taken in a product's own
prose, so this surface is always written **agent shell** in full.

A shell holds three things and nothing else, over the `name:` that is its address: a `skills:`
preload naming the plugin-namespaced skill it exists to run, a `tools:` set scoped to what that
skill actually calls, and a `description:` saying when to spawn it. `model:` is the one optional
field (see below). All judgement — every step, rubric, acceptance test and terminal token — lives
in the preloaded skill, which is the surface the eval bar gates.

**No shell pins `effort:`, and no driver passes one when spawning a shell.** An omitted field
inherits the spawning session's effort, which is what a human naming the run should control.

**A shell that grows opinions is a defect** — anything a shell should "always do" belongs in its
skill, never in the shell body.

## The eight shells

| Shell | Preloads |
|---|---|
| `triager` | `fabrika:triage` |
| `builder` | `fabrika:build` |
| `ui-builder` | `fabrika:build-ui` |
| `mixed-builder` | `fabrika:build` and `fabrika:build-ui` |
| `reviewer` | `fabrika:review` |
| `ui-reviewer` | `fabrika:review-ui` |
| `shipper` | `fabrika:ship` |
| `operator` | `fabrika:operate` |

`mixed-builder` is the one shell that preloads two skills: it lands a ticket whose deliverable spans
text and a rendered surface as one pull request.

## A shell's name is a noun

**Name a shell for the thing that acts, never for the act**: `builder`, `reviewer`, `shipper`,
`operator`. A shell named for the act collides with the skill it loads and with every other
definition that performs it, and the collision is invisible until two definitions contend for one
address.

**On the Agent tool, the address is the plugin-qualified noun.** A driver spawns
`fabrika:reviewer`; the bare `reviewer` names the shell in prose and in its own `name:` field.
Observed on Claude Code 2.1.288: an Agent-tool spawn of `reviewer` was refused as not found, with
the eight shells listed as `fabrika:builder` through `fabrika:ui-reviewer`, and the same spawn of
`fabrika:reviewer` ran. The only proof of which form resolves in a given harness is spawning it.

The `--agent` launch flag is a separate resolver, and this page states nothing current about it.
The one record is from Claude Code 2.1.214, where `--agent plugin:name` did not resolve; it has not
been re-run since.

## No `memory:`

No shell declares `memory:` in any form. Repo knowledge belongs in the host repository's own pattern
docs, where every session reads it, not in a per-shell store only that shell can see.

## The model a shell runs on

**Nothing enforces it.** The `PreToolUse` hook that denied an off-allowlist spawn is retired: which
model a subagent runs on is a per-run human choice, named at the spawn, and a hook that second-
guesses it only blocks the choice the human already made.

Every shell leaves `model:` unset, so a spawn inherits the caller's model unless the caller names
one. The unused model vocabulary and its tests were also deleted; historical lookup stays in git.

## Which shells carry a spawn tool

Every shell does. Each definition declares the harness spawn tool, `Agent`, in `tools:`. The grant
is baseline: a new shell declares `Agent` at creation. Read `tools:` in
[`../agents/`](../agents/) for what a shell carries, not this page — the definitions are the
statement.

The grant is not decorative for the operator: every stage the operate loop
([`../skills/operate/SKILL.md`](../skills/operate/SKILL.md)) dispatches is a spawn of another shell,
so an operator without it can dispatch nothing. The loop's other routes spawn nothing — on a chore
lane it applies a recipe verb itself.

A spawn tool is not a `Skill` grant: `shipper` holds none — the ship skill routes by writing a
ship note and stopping.

Write the tool's canonical name, `Agent` — the `name` on the spawn tool in the Claude Code 2.1.233
bundle, which also carries `aliases: ["Task"]`. Both strings grant the tool; `Agent` is the house
choice. An unrecognised `tools:` entry drops silently — no warning, no non-zero exit — so a grant
is proven by spawning, not by the file parsing.

## Fields a plugin-scope shell may not use

`permissionMode:`, `hooks:` and `mcpServers:` are dropped for plugin-scope agent definitions with
a load-time warning (`…, which is ignored for plugin agents. Use .claude/agents/ for this level of
control.`, read out of Claude Code 2.1.288). None of the three appears on any shell.
