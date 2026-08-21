# Agent shells

An **agent shell** is a behaviour-free agent definition under
[`../agents/`](../agents/) whose only job is to be a spawn target with a fabrika skill already
loaded. It is not the phoenix UI `Shell` (`SubnavShell` / `PageShell`, ADR 0182) — that word is
taken in phoenix prose, so this surface is always written **agent shell** in full.

A shell holds three things and nothing else, over the `name:` that is its address: a `skills:`
preload naming the one plugin-namespaced skill it exists to run, a `tools:` set scoped to what that
skill actually calls, and a `description:` saying when to spawn it. `model:` is the one optional
field, governed by the allowlist below. All judgement — every step, rubric, acceptance test and
terminal token — lives in the preloaded skill, which is the surface the eval bar gates.

**No shell pins `effort:`, and no driver passes one when spawning a shell** — ADR
[0310](../../../.decisions/0310-no-agent-shell-pins-effort.md), founder ruling of 2026-08-15
extended 2026-08-16. A pinned effort changes model behaviour with nothing surfacing the change: no
gate reds, no output looks different, and a reader cannot tell the setting was in play. An omitted
field inherits the spawning session's effort, so the value stays in one place the operator can see.

**A shell that grows opinions is a defect.** An instruction in a shell body is behaviour that never
faces the evals, and it silently forks from the skill the moment the skill changes. Anything you
want a shell to "always do" belongs in its skill.

## A shell's name is a noun

**Name a shell for the thing that acts, never for the act.** `builder`, `reviewer`, `shipper`,
`operator` — and whatever the fifth turns out to be, it is named the same way. Founder ruling of 2026-08-15, ADR
[0281](../../../.decisions/0281-agent-names-are-nouns.md), which binds every agent definition in
this repo and not only these three.

The concrete reason is a collision. A shell exists to run one skill, so a shell named for the act is
spelled exactly like the skill: the skill is `review` and a shell called `review` is
indistinguishable from it in a prompt, in a workflow script, and in a log line. A `reviewer` shell
loading the `review` skill reads in one pass; a `review` shell loading the `review` skill does not.
The noun also says the true thing about a shell — it is a seat that loads instructions, not the
instructions.

**The address is the bare noun.** ADR
[0195](../../../.decisions/0195-crew-agent-def-name-collision-free-convention.md) records that a
bare `name:` becomes the def's `agentType` verbatim with no plugin-namespace prefix, and that the
plugin-qualified `plugin:name` form does not resolve. So a driver spawns `reviewer`, not
`fabrika:reviewer` — the qualified spelling names the plugin's shell in prose. That platform fact is
recorded at Claude Code 2.1.214 and is not re-proven here;
[#5590](https://github.com/kamp-us/phoenix/issues/5590) is the spawn that settles which form
resolves today.

**Two of these names used to be spelled elsewhere.** The retired v1 plugin's
`claude-plugins/kampus-pipeline/agents/` carried `reviewer.md` and `shipper.md`, so while both
plugins existed they contended for one `agentType`. That contention is over: those definitions
reached the project agent-load path through the tracked `.claude/agents` symlink — which ADR
[0255](../../../.decisions/0255-skill-namespaces-keep-v1-and-fabrika-apart.md) §4 records loaded
them *regardless of the plugin toggle* — and
[#5599](https://github.com/kamp-us/phoenix/issues/5599) deleted that symlink on 2026-08-15 (ADR
[0277](../../../.decisions/0277-v1-retirement-keeps-the-plugin-suppression.md)); the plugin tree
itself, along with its `kampus-pipeline@kampus: false` suppression line in
`.claude/settings.json`, was deleted outright by ADR
[0303](../../../.decisions/0303-retire-kampus-pipeline-plugin.md) (#5937). Fabrika's four shells
are the only definitions spelling these names now.

## Why exactly four

`builder`, `reviewer` and `shipper` — founder ruling of 2026-08-14 (epic
[#5492](https://github.com/kamp-us/phoenix/issues/5492)), verbatim *"three sounds right"* — and,
since 2026-08-16, the `operator`: the driver's own seat, added by the founder's phase-2 ruling on
epic [#5680](https://github.com/kamp-us/phoenix/issues/5680) (naming ruled in that epic's
comments: skill `operate`, shell `operator`). A shell earns its place only where a driver needs
something to spawn, and the operator is that rule's own case — the founder spawns it so driving a
lane stops costing him a live session, and it in turn spawns the other three. Every other fabrika
skill is invoked by name from a plain session and needs no definition of its own.

The shells ship inside the plugin, so every adopting repo inherits all four. Pick a fifth for
what a driver must spawn, never for what is convenient in one repo.

## No `memory:`

No shell declares `memory:` in any form — founder ruling of 2026-08-14, verbatim *"no memory on
shells"*. A reviewer that quietly accumulated judgement from a file nobody reviews gives verdicts
nobody can reproduce from its skill text. Repo knowledge belongs in
[`.patterns/`](../../../.patterns/index.md).

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

Every shell does. `builder`, `reviewer`, `shipper`, `operator` and `triager` each declare the
harness spawn tool, `Agent`, in `tools:` — founder ruling of 2026-08-16 on
[#5686](https://github.com/kamp-us/phoenix/issues/5686), that every role shell should be able to
spawn subagents, with the retired pipeline-crew's over-restricted tool sets as the named failure
mode. ADR [0311](../../../.decisions/0311-every-agent-shell-carries-the-spawn-tool.md) records it.
The grant is baseline, so a new shell declares `Agent` at creation rather than arguing for it.

**Read `tools:` in [`../agents/`](../agents/) for what a shell carries, not this paragraph.** The
definitions are the statement; a doc is a summary of them, and it is a summary that has already
drifted once.

The reviewer's grant came first and rests on its own reason, which is why ADR
[0280](../../../.decisions/0280-review-shell-carries-the-spawn-tool.md) still stands and is only
amended in part. For the reviewer the grant is a tool grant and nothing more: the behaviour stays in
[`../skills/review/SKILL.md`](../skills/review/SKILL.md) §6, which makes the `governance` namespace
**derived-required** on a `governance: required` diff — fire the `governance` skill, wait for it, and never
emit that namespace yourself. Without a spawn tool the shell derives that requirement mid-run and
dead-ends, leaving the PR with a governance check nothing in the run can clear. The grant only lets
the shell obey an instruction it already carried. Founder ruling of 2026-08-14 on
[#5558](https://github.com/kamp-us/phoenix/issues/5558), verbatim *"yeah, review shell carries the
spawn tool"*. 0280 predates the noun rename and calls this shell `review`; 0311 widens who holds the
tool and nothing else.

For the operator the spawn tool is the skill itself: every route in the `operate` loop
([`../skills/operate/SKILL.md`](../skills/operate/SKILL.md)) is a spawn of one of the other shells,
so a spawn-less operator drives nothing.

A spawn tool is not a `Skill` grant. `shipper` holds none: the `ship` skill routes by writing a
`ship note` and stopping.

Write the tool's canonical name, `Agent` — the `name` on the spawn tool in the Claude Code 2.1.233
bundle, which also carries `aliases: ["Task"]`. Both strings grant the tool (a shell built with
`"Task"` reported `Agent` available), so `Agent` is a house choice, not the only one that works.

Prove a grant by spawning, never by the file parsing: a `tools:` entry the harness does not
recognise drops with no warning and no non-zero exit. A shell whose `tools:` named `SpawnAgent`
loaded cleanly and reported exactly the tools it would have had without the entry.

## Fields a plugin-scope shell may not use

`permissionMode:`, `hooks:` and `mcpServers:` are dropped for plugin-scope agent definitions with a
load-time warning (`…, which is ignored for plugin agents. Use .claude/agents/ for this level of
control.`, read out of Claude Code 2.1.233). A shell that declares one is not stricter, only
noisier — none of the three appears.
