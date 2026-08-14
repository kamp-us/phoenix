---
id: 0255
title: v1 and fabrika skills coexist under separate namespaces; the `.claude/skills` symlink is the retirement lever
status: amended-in-part by [0277](0277-v1-retirement-keeps-the-plugin-suppression.md)
date: 2026-08-10
tags: [fabrika, skills, plugin, pipeline, vocabulary]
---

# 0255 — v1 and fabrika skills coexist under separate namespaces; the `.claude/skills` symlink is the retirement lever

**What this decides:** during the fabrika rebuild wave a v1 skill and its fabrika rebuild both stay
loaded. They do not share a name — the loader namespaces them apart — so the bare name keeps meaning
v1 and the rebuild is reached as `fabrika:<name>`. The `.claude/skills` symlink stays until v1
retires wholesale, at which point deleting it retires the whole v1 roster in one edit.

## Context

[#4829](https://github.com/kamp-us/phoenix/issues/4829) reports that `.claude/skills` is a tracked
symlink into the v1 plugin tree, so the v1 skill set loads on every checkout even though
`.claude/settings.json` disables the plugin (`"kampus-pipeline@kampus": false`). That much is true
and confirmed. The report's consequence — that a v1 skill and its fabrika rebuild are "both
model-invoked under one name" — is not, and the difference decides the fork.

The issue offered two branches: change v1's loading path so the toggle means what it says, or accept
the collision and correct the record. It also asked that the bare-name resolution order be
established by measurement rather than left as preserved uncertainty. It was measured.

### What was measured, and how

Two independent observations, both taken 2026-08-10 against Claude Code 2.1.226.

**1. The loader namespaces plugin skills and refuses to namespace anything else.** Read out of the
shipped CLI: the Skill tool's own instruction text says verbatim *"Plugin skills use
`plugin:skill`."*, and the skill-name validator says verbatim that *"Skill names match the skill's
directory name (or 'plugin:skill' for plugin-qualified skills)"* — a filesystem skill's name is
derived from its directory, and the colon spelling is reserved for the plugin-qualified form. Do
**not** go looking for the familiar *"names must not contain ':' (reserved for plugin namespacing)"*
rejection under skills: that message occurs at exactly two sites in the shipped binary and both are
on the **agent** path (`parseAgentFromMarkdown` and the agent parse-error helper). A project-level
skill therefore **cannot** carry a namespaced name, and a plugin skill **always** does. The two
name-spaces are disjoint by construction, so no bare name is contested — save through the opt-in
`fallback` frontmatter field, which no skill in this repo declares.

**2. A live phoenix session's roster carries both sets, under both spellings.** The roster of a real
session in this repo lists bare `adr`, `plan-epic`, `report`, `triage`, `write-code`, `review-code`
and the rest of the v1 set **and** `fabrika:adr`, `fabrika:plan-epic`, `fabrika:report`,
`fabrika:triage` and their siblings. Both sets are model-invocable at once. Neither shadows the
other.

**So the resolution order is not a race — it is a rule.** The bare name resolves to v1, always and
only. The fabrika rebuild is reachable only as `fabrika:<name>`. There is no coin flip, no
first-loaded-wins, and nothing for a tie-break rule to decide.

### Why the toggle does not gate the symlink, and why that is deliberate

ADR [0077](0077-in-repo-pipeline-skill-discovery-doubling.md) already settled this and is not
falsified by the report. The suite ships twice inside phoenix — in-repo through the `.claude/skills`
symlink, and as the `kampus-pipeline@kampus` plugin — and Claude Code does no cross-scope dedupe, so
every v1 skill used to appear twice in one picker. 0077's fix was to keep the symlink as the
canonical in-repo discovery source and disable the *plugin* copy. The toggle suppresses the copy it
was aimed at. It was never meant to reach the symlink, and a toggle that did would undo 0077.

The plugin loader does drop a plugin skill whose real path is already surfaced by the skills
directory loader, but that check is scoped to the **user-level** skills directory, not a project's
`.claude/skills`. It is not a second mechanism anyone can lean on here.

### What the live defect actually is

Names never collide; **descriptions** do. A skill is model-invoked off its frontmatter `description`,
so two roster entries that describe the same job compete for the same request whatever they are
called. `fabrika:report` and bare `report` both answer "file a follow-up issue". That overlap is
real, it is live today, and it is the only part of the report that survives measurement.

It is also the part the existing mitigation was aimed at. `claude-plugins/fabrika/skills/report/contract.md`
recorded the collision as "dormant only by configuration" and offered description differentiation as
a stopgap. The premise was wrong; the mitigation was right, and
`claude-plugins/fabrika/skills/triage/contract.md` had already corrected the premise on its own and
landed on the same answer — the bare name resolves to v1, the rebuild is `/fabrika:triage`.

## Decision

**v1 and fabrika skills coexist. The namespace is the discriminator, description differentiation is
the mitigation, and the `.claude/skills` symlink stays until v1 retires as a whole.**

This is the issue's branch 2, taken because branch 1 solves a problem that was not there.

### 1. The naming rule

| written as | means |
|---|---|
| bare `adr`, `report`, `triage`, `plan-epic`, `write-code`, … | the **v1** skill, loaded project-level through `.claude/skills` |
| `fabrika:adr`, `fabrika:report`, `fabrika:triage`, … | the **fabrika** skill, loaded from the plugin |

**A bare skill name in prose, a dispatch brief, or an agent definition means v1.** Whenever fabrika's
copy is meant, write the qualified `fabrika:<name>`. This is the same read-the-namespace rule ADR
[0246](0246-graduate-keeps-its-name-disambiguated.md) applied to `graduate`, and it holds for the
same reason: an unrecorded homonym does not fail loudly, it hands a reader a confident wrong answer.

### 2. Why the loading path is not cut now

Cutting the symlink would be a live cutover of the running factory, and it buys nothing that is
missing. Three reasons, in the order they bind:

- **There is no ambiguity to remove.** The measurement above shows the bare name is unambiguously
  v1's. A cutover that resolves a name conflict has no name conflict to resolve.
- **The crew runs on v1 today.** Every pipeline agent and every crew session reaches v1 through this
  path. Removing it mid-wave breaks the only working pipeline in exchange for a roster that is merely
  shorter.
- **It undoes ADR 0077 by halves.** 0077 makes the symlink and the plugin toggle one pair: drop the
  symlink and the suppression must go in the same change, or the suite becomes unreachable in-repo.
  A half-cutover is worse than either end state.

The cost of waiting is bounded and named: a longer roster, and description overlap on the four names
that exist in both sets today (`adr`, `plan-epic`, `report`, `triage`).

### 3. Cutover sequencing — one lever, pulled once

v1 retires **as a set, not skill by skill**. The sequence:

1. **Now.** Both sets load. v1 owns the bare names and remains authoritative for the running
   pipeline. fabrika skills are reached qualified. No change under
   `claude-plugins/kampus-pipeline/` on account of a name — v1 is the frozen baseline (ADR
   [0238](0238-fabrika-reimplements-v1-never-calls-it.md)).
2. **While the wave runs.** A fabrika skill's description is the discriminator. Whether it actually
   fires is settled by its eval set, not by assertion — ADR
   [0249](0249-skill-trigger-coverage-lives-in-the-eval-set.md) owns that measurement, and this entry
   adds no second verdict on it.
3. **At retirement.** When fabrika covers the pipeline and its eval sets show its skills fire,
   **delete the `.claude/skills` symlink and remove the `kampus-pipeline@kampus` suppression from
   `.claude/settings.json` in the same change** (0077's own standing instruction). That single edit
   retires the entire v1 roster at once. The symlink is not the problem here — it is the cheapest
   cutover lever available, because one deletion does what per-skill work never could.

**Never gate, rename, or retire the symlink per skill.** A partially-cut roster is a state where the
bare name means v1 for some skills and nothing for others, which is the ambiguity this whole entry
establishes does not currently exist.

### 4. `.claude/agents` — same mechanism, same lever, no collision today

`.claude/agents` is the same tracked symlink into the v1 tree, and it materializes v1's agent
definitions at the project agent-load path regardless of the plugin toggle. Two things follow:

- **There is no agent-name collision.** fabrika ships no agent definitions — its plugin root carries
  `skills/`, `docs/`, `hooks.json` and its manifest, and no `agents/` directory. Nothing contests
  those names.
- **It retires on the same lever.** When step 3 fires, `.claude/agents` goes with `.claude/skills` in
  the same change. Agents are dispatched by explicit type rather than chosen off a description, so
  they carry none of the description-overlap cost and need no interim mitigation.

### 5. `.claude/.pipeline` is unaffected — triage's read is confirmed

The tracked-symlink precedent from [#4818](https://github.com/kamp-us/phoenix/issues/4818) /
[PR #4825](https://github.com/kamp-us/phoenix/pull/4825) stands unchanged. `.claude/.pipeline` is a
path alias that scripts and hooks resolve by literal path; it is not a directory the loader builds a
roster from, so it injects nothing into the model's choices. The property it inherits — content
present on disk whatever the toggle says — is exactly what #4818 wanted.

The general rule that precedent establishes needs one qualifier, stated here rather than left
implicit: **tracking a symlink is safe for a path alias, and is a roster decision for a load-path
directory.** `.claude/skills` and `.claude/agents` are load paths; `.claude/.pipeline` is not.

### Binding constraints

- A bare skill name means v1. Prose meaning fabrika's copy writes `fabrika:<name>`.
- A fabrika skill's description must discriminate against its v1 counterpart's; its eval set is what
  establishes that it does.
- No change under `claude-plugins/kampus-pipeline/` on account of a name collision (ADR 0238).
- `.claude/skills` and `.claude/agents` retire together with the 0077 suppression removal, in one
  change.

### Banned

- Gating, renaming or retiring `.claude/skills` per skill.
- Deleting the symlink without removing the `kampus-pipeline@kampus` suppression in the same change.
- Recording anywhere that the plugin toggle gates what the symlink loads, or that the bare name is
  contested.

## Consequences

- The four names that exist in both sets today (`adr`, `plan-epic`, `report`, `triage`) stay
  reachable under both spellings, deliberately and on the record.
- A reader who meets `report` cold has one mechanical rule — read the namespace — instead of a
  guess.
- The roster stays long for the length of the wave. That is the accepted cost, and it buys a pipeline
  that keeps running while its replacement is built.
- Retirement stays a one-edit act rather than a migration, which is the property worth protecting.
- ADR 0077 is confirmed, not superseded: its decision text and status are unchanged, and this entry
  adds only the measured detail that the toggle's scope is the plugin copy and never the symlink.
- Nothing else is superseded, amended, or edited.

## Records

- Discharges the decision half of
  [#4829](https://github.com/kamp-us/phoenix/issues/4829). `claude-plugins/fabrika/skills/report/contract.md`
  is corrected to point here in the same PR.
- The mechanical follow-ups this choice implies are filed separately:
  [#5276](https://github.com/kamp-us/phoenix/issues/5276) holds the one-change retirement of §3 step
  3, and [#5275](https://github.com/kamp-us/phoenix/issues/5275) covers the `DEVELOPMENT.md` path
  pins that neither #4761 nor #4762 scopes.
- The routing-pin half — repo docs that reference a skill by a `.claude/skills/...` filesystem path
  rather than by name — is [#4761](https://github.com/kamp-us/phoenix/issues/4761) /
  [#4762](https://github.com/kamp-us/phoenix/issues/4762) and is not touched here.
- No `.glossary/` row is owed: the rule above is about namespaces, not about a term gaining a second
  sense.
