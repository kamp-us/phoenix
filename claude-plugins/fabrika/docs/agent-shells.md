# Agent shells

An **agent shell** is a behaviour-free agent definition under
[`../agents/`](../agents/) whose only job is to be a spawn target with a fabrika skill already
loaded. It is not the phoenix UI `Shell` (`SubnavShell` / `PageShell`, ADR 0182) — that word is
taken in phoenix prose, so this surface is always written **agent shell** in full.

A shell holds four things and nothing else: a `skills:` preload naming the one plugin-namespaced
skill it exists to run, a `tools:` set scoped to what that skill actually calls, an `effort:`
setting, and a `description:` saying when to spawn it. All judgement — every step, rubric,
acceptance test and terminal token — lives in the preloaded skill, which is the surface the eval
bar gates.

**A shell that grows opinions is a defect.** An instruction in a shell body is behaviour that never
faces the evals, and it silently forks from the skill the moment the skill changes. Anything you
want a shell to "always do" belongs in its skill.

## A shell's name is a noun

**Name a shell for the thing that acts, never for the act.** `builder`, `reviewer`, `shipper` — and
whatever the fourth turns out to be, it is named the same way. Founder ruling of 2026-08-15, ADR
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
resolves today. Two names in this set — `reviewer` and `shipper` — are also spelled by
`claude-plugins/kampus-pipeline/agents/`, so in a repo where both plugins are enabled they contend
for one `agentType`; phoenix is not such a repo, because `.claude/settings.json` suppresses that
plugin (ADR [0277](../../../.decisions/0277-v1-retirement-keeps-the-plugin-suppression.md)).

## Why exactly three

`builder`, `reviewer` and `shipper`, and no fourth — founder ruling of 2026-08-14 (epic
[#5492](https://github.com/kamp-us/phoenix/issues/5492)), verbatim *"three sounds right"*. A shell
earns its place only where a driver needs something to spawn, and those are the three heavy
pipeline stages. Every other fabrika skill is invoked by name from a plain session and needs no
definition of its own.

The shells ship inside the plugin, so every adopting repo inherits all three. Pick a fourth for
what a driver must spawn, never for what is convenient in one repo.

## No `memory:`

No shell declares `memory:` in any form — founder ruling of 2026-08-14, verbatim *"no memory on
shells"*. A reviewer that quietly accumulated judgement from a file nobody reviews gives verdicts
nobody can reproduce from its skill text. Repo knowledge belongs in
[`.patterns/`](../../../.patterns/index.md).

## The model allowlist

`model:` is either absent or exactly one of `claude-opus-4-8` / `claude-opus-4-8[1m]` —
`ALLOWLIST` in [`packages/fabrika-cli/src/models.ts`](../../../packages/fabrika-cli/src/models.ts).
`decideSpawn` in [`packages/fabrika-cli/src/hook/spawn.ts`](../../../packages/fabrika-cli/src/hook/spawn.ts)
denies an explicit off-allowlist model unconditionally, and no pin overrides that deny. An unset
`model` reaches the inherit branch **only when the effective pin is itself allowlisted** — the
`AllowInherit` return sits inside `if (isAllowlisted(effectivePin))`, so a `WORKFLOW_MODEL` that is
present but off the allowlist denies an unset request too (with `explicit: false`). An absent pin
resolves to the committed default, which is allowlisted, so an unset `model` passes on a machine
that never exported `WORKFLOW_MODEL`. All three shells today leave it unset, so a spawn runs on the
caller's own model whenever the pin is sane.

## Only the reviewer carries a spawn tool

`reviewer` is the one shell whose `tools:` includes the harness spawn tool, `Agent`. That is a tool
grant and nothing more: the behaviour stays in
[`../skills/review/SKILL.md`](../skills/review/SKILL.md) §6, which makes the `governance` namespace
**derived-required** on a `harness: true` diff — fire the `governance` skill, wait for it, and never
emit that namespace yourself. Without a spawn tool the shell derives that requirement mid-run and
dead-ends, leaving the PR with a governance check nothing in the run can clear. The grant only lets
the shell obey an instruction it already carried. Founder ruling of 2026-08-14 on
[#5558](https://github.com/kamp-us/phoenix/issues/5558), verbatim *"yeah, review shell carries the
spawn tool"*. Its decision record is ADR
[0280](../../../.decisions/0280-review-shell-carries-the-spawn-tool.md), which predates the noun
rename and calls this shell `review`.

`builder` and `shipper` get no spawn tool: neither skill invokes another agent. The `ship` skill
routes by writing a `ship note` and stopping, so `shipper` holds no `Skill` grant either.

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
