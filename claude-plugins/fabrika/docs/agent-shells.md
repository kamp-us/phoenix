# Agent shells

An **agent shell** is a behaviour-free agent definition under
[`../agents/`](../agents/) whose only job is to be a spawn target with a fabrika skill already
loaded. It is not the phoenix UI `Shell` (`SubnavShell` / `PageShell`, ADR 0182) — that word is
taken in phoenix prose, so this surface is always written **agent shell** in full.

A shell holds three things and nothing else, over the `name:` that is its address: a `skills:`
preload naming the one plugin-namespaced skill it exists to run, a `tools:` set scoped to what that
skill actually calls, and a `description:` saying when to spawn it. `model:` is the one optional
field. All judgement — every step, rubric, acceptance test and terminal token — lives in the
preloaded skill, which is the surface the eval bar gates.

**No shell pins `effort:`, and no driver passes one when spawning a shell** — founder ruling of
2026-08-15 extended 2026-08-16; the reasoning lives in ADR
[0310](../../../.decisions/0310-no-agent-shell-pins-effort.md). An omitted field inherits the
spawning session's effort.

**A shell that grows opinions is a defect.** An instruction in a shell body is behaviour outside
the skill the eval bar gates; anything you want a shell to "always do" belongs in its skill. ADR
[0311](../../../.decisions/0311-every-agent-shell-carries-the-spawn-tool.md) binds the same law from
the tools side: the spawn grant moves no judgement into the shell.

## A shell's name is a noun

**Name a shell for the thing that acts, never for the act**: `builder`, `reviewer`, `shipper`,
`operator` — whatever the seat, it is named the same way. Founder ruling of 2026-08-15 — ADR
[0281](../../../.decisions/0281-agent-names-are-nouns.md), which binds every agent definition in
this repo and not only these shells; the collision the rule removes, and the reading of a shell as a
seat rather than the instructions it loads, are argued there.

**The address is the bare noun.** ADR
[0195](../../../.decisions/0195-crew-agent-def-name-collision-free-convention.md) records that a
bare `name:` becomes the def's `agentType` verbatim with no plugin-namespace prefix, and that the
plugin-qualified `plugin:name` form does not resolve. So a driver spawns `reviewer`, not
`fabrika:reviewer` — the qualified spelling names the plugin's shell in prose. That platform fact is
recorded at Claude Code 2.1.214;
[#5590](https://github.com/kamp-us/phoenix/issues/5590) is the spawn that settles which form
resolves today.

**Two of these names were once contested.** The retired v1 plugin's
`claude-plugins/kampus-pipeline/agents/` carried `reviewer.md` and `shipper.md`. That history — the
tracked `.claude/agents` symlink that loaded them regardless of the plugin toggle (ADR
[0255](../../../.decisions/0255-skill-namespaces-keep-v1-and-fabrika-apart.md) §4), the symlink's
deletion on 2026-08-15 ([#5599](https://github.com/kamp-us/phoenix/issues/5599), ADR
[0277](../../../.decisions/0277-v1-retirement-keeps-the-plugin-suppression.md)), and the v1 plugin
tree's deletion outright (ADR
[0303](../../../.decisions/0303-retire-kampus-pipeline-plugin.md), #5937) — is recorded in those
decisions and in ADR [0281](../../../.decisions/0281-agent-names-are-nouns.md)'s collision check.
Fabrika's shells are the only definitions spelling these names now.

## The shell roster

The seats were added by founder ruling: `builder`, `reviewer` and `shipper` on 2026-08-14 (epic
[#5492](https://github.com/kamp-us/phoenix/issues/5492), verbatim *"three sounds right"*), and
`operator` on 2026-08-16 by the phase-2 ruling on epic
[#5680](https://github.com/kamp-us/phoenix/issues/5680) (skill `operate`, shell `operator`, named in
that epic's comments).

A seat exists where a driver needs something to spawn; every other fabrika skill is invoked by name
from a plain session and needs no definition of its own. The shells ship inside the plugin, so every
adopting repo inherits them.

## No `memory:`

No shell declares `memory:` in any form — founder ruling of 2026-08-14, verbatim *"no memory on
shells"*. Repo knowledge belongs in [`.patterns/`](../../../.patterns/index.md).

## The model a shell runs on

**Nothing enforces it.** The `PreToolUse` hook that denied an off-allowlist spawn is retired — ADR
[0331](../../../.decisions/0331-fabrika-spawn-hook-retired.md), which carries ADR
[0282](../../../.decisions/0282-spawn-guard-retired.md)'s ruling into fabrika. Which model a
subagent runs on is a per-run human choice, named at the spawn.

Every shell leaves `model:` unset, so a spawn inherits the caller's model unless the caller names
one. [`packages/fabrika-cli/src/models.ts`](../../../packages/fabrika-cli/src/models.ts) is still
the house vocabulary — the canonical ids and their harness aliases — but it is a table a reader
consults, not a gate anything passes.

## Which shells carry a spawn tool

Every shell does: `builder`, `reviewer`, `shipper`, `operator` and `triager` each declare the
harness spawn tool, `Agent`, in `tools:` — founder ruling of 2026-08-16 on
[#5686](https://github.com/kamp-us/phoenix/issues/5686), recorded in ADR
[0311](../../../.decisions/0311-every-agent-shell-carries-the-spawn-tool.md). The grant is
baseline, so a new shell declares `Agent` at creation rather than arguing for it.

**Read `tools:` in [`../agents/`](../agents/) for what a shell carries, not this paragraph.** The
definitions are the statement; a doc is a summary of them, and it is a summary that has already
drifted once.

Two grants predate or specialize the baseline:

- The **reviewer**'s came first and rests on its own reason — ADR
  [0280](../../../.decisions/0280-review-shell-carries-the-spawn-tool.md), still standing and
  amended only in who holds the tool by
  [0311](../../../.decisions/0311-every-agent-shell-carries-the-spawn-tool.md). The behaviour it
  serves lives in [`../skills/review/SKILL.md`](../skills/review/SKILL.md) §6, which makes the
  `governance` namespace derived-required on a `governance: required` diff.
- For the **operator**, the grant is the loop itself: every route in
  [`../skills/operate/SKILL.md`](../skills/operate/SKILL.md) spawns one of the other shells.

A spawn tool is not a `Skill` grant. `shipper` holds none: the `ship` skill routes by writing a
`ship note` and stopping.

Write the tool's canonical name, `Agent` — the `name` on the spawn tool in the Claude Code 2.1.233
bundle, which also carries `aliases: ["Task"]`. Both strings grant the tool, so `Agent` is a house
choice, not the only one that works.

Prove a grant by spawning, never by the file parsing: a `tools:` entry the harness does not
recognise drops with no warning and no non-zero exit. A shell whose `tools:` named `SpawnAgent`
loaded cleanly and reported exactly the tools it would have had without the entry.

## Fields a plugin-scope shell may not use

`permissionMode:`, `hooks:` and `mcpServers:` are dropped for plugin-scope agent definitions with a
load-time warning (`…, which is ignored for plugin agents. Use .claude/agents/ for this level of
control.`, read out of Claude Code 2.1.233). None of the three appears in any shell under
[`../agents/`](../agents/).
