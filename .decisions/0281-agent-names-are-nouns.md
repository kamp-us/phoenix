---
id: 0281
title: Agent names are nouns
status: accepted
date: 2026-08-15
tags: [pipeline, fabrika, agents, naming]
---

# 0281 — Agent names are nouns

**What this decides:** every agent definition in this repo is named for the thing that acts, not for
the act. `builder`, `reviewer`, `shipper` — never `build`, `review`, `ship`. No skill is renamed.

## Context

The three fabrika agent shells landed on 2026-08-14 named `build`, `review` and `ship`
([#5586](https://github.com/kamp-us/phoenix/issues/5586)), each with a `skills:` preload naming the
same-spelled skill. So `claude-plugins/fabrika/agents/review.md` carried `name: review` and
`skills: ["fabrika:review"]`, and the seat and the instructions it loads became one string.

That string is ambiguous everywhere it is read. In a prompt, in a workflow script's `agentType`, and
in a log line, `review` is either the skill or the shell and nothing distinguishes them. A shell
named `reviewer` that loads the `review` skill reads in one pass.

**How a shell is addressed, stated exactly.** ADR
[0195](0195-crew-agent-def-name-collision-free-convention.md) records that under Claude Code 2.1.214
a bare `name:` becomes the def's `agentType` verbatim with no plugin-namespace prefix, and that the
plugin-qualified `--agent plugin:name` form does **not** resolve. Under that mechanism the address of
these shells is the bare noun — `builder`, `reviewer`, `shipper` — and `fabrika:builder` is prose
naming the plugin's shell, not a spawn target. Whether 0195's fact still holds at the version in use
is **not** established here: no spawn was run for this rename, and
[#5590](https://github.com/kamp-us/phoenix/issues/5590) carries the proof, which must spawn the bare
noun and the qualified form both and record which resolved.

The name also misdescribes what a shell is. A shell carries no behaviour by design
([`claude-plugins/fabrika/docs/agent-shells.md`](../claude-plugins/fabrika/docs/agent-shells.md),
"A shell that grows opinions is a defect"), and an imperative name reads as a command — an invitation
to the exact misreading that rule exists to prevent.

## Decision

**An agent's `name:` is a noun — the actor, never the action.**

- It binds every agent definition in this repo, not only the three fabrika shells, and it binds the
  fourth shell nobody has written yet.
- No skill is renamed. `build`, `review` and `ship` keep their spellings — and two of them are
  registered domain nouns in their own right: ADR
  [0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) admits `build` and `review` to
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) as canonical names for the skills. So this rule is
  **not** "agents are nouns, skills are verbs" — a skill name's grammar is not decided here. It is
  that an agent's name is the actor, and never the bare spelling of the skill it preloads. The pair
  reads: the `builder` shell runs the `build` skill.
- The three shells are renamed `builder`, `reviewer`, `shipper`, filename and `name:` frontmatter
  together, since the doc treats them as a matched pair.

**Banned.** An agent definition whose `name:` is the bare spelling of the skill it preloads. Renaming
a skill to resolve the collision from the other side.

## The collision check this rests on

ADR [0195](0195-crew-agent-def-name-collision-free-convention.md) records that under Claude Code
2.1.214 a bare `name:` became the def's `agentType` verbatim with no plugin-namespace prefix, so a
same-named user-scope def shadowed the plugin def under last-write-wins dedup. Its fix — the
`crew-<role>` prefix — is a convention local to the crew plugin, not a repo-wide naming law, so it
does not conflict with this one.

`builder` / `reviewer` / `shipper` were checked against that mechanism before being adopted:

- **Inside phoenix the collision was live until 2026-08-15, and what closed it was the deletion of a
  load path, not a toggle.** `claude-plugins/kampus-pipeline/agents/reviewer.md` and `shipper.md`
  carry two of these names. ADR
  [0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md) §4 states the mechanism: `.claude/agents`
  was a tracked symlink into the v1 tree and it *"materializes v1's agent definitions at the project
  agent-load path regardless of the plugin toggle"*. The `"kampus-pipeline@kampus": false` line in
  `.claude/settings.json` reaches the plugin copy and never reached that symlink — 0255 §2 measured
  it, ADR [0277](0277-v1-retirement-keeps-the-plugin-suppression.md) quotes the measurement, and
  0255's Banned list forbids recording that the toggle gates what the symlink loads. So for as long
  as the symlink existed, bare `reviewer` and `shipper` were live project-scope agent definitions in
  this repo. [#5599](https://github.com/kamp-us/phoenix/issues/5599) deleted both `.claude` symlinks
  on 2026-08-15 (`a0ae0bd3`), executing 0277's decision; `git ls-tree origin/main .claude/` now
  returns `.pipeline`, `settings.json` and `workflows` and nothing else. The v1 definitions no longer
  materialize at any agent-load path in this repo, so the in-repo collision is gone — because the
  load path was removed, not because a toggle was gating it. The surviving suppression is a separate
  door: it keeps the plugin copy off a machine where someone installs `kampus-pipeline` (0277).
- **ADR [0279](0279-v1-crew-retired-in-full.md) does not retire kampus-pipeline.** It retires the v1
  *crew* in full and keeps `claude-plugins/kampus-pipeline/` alive on a live-consumer fact — someone
  outside this repository installs the suite from it — and bans touching it as part of that
  retirement. Reading 0279 as a full retirement is the misreading that hides the next bullet.
- **Outside phoenix the collision is live, and this decision carries it.** fabrika ships as an
  installed plugin (ADR [0273](0273-fabrika-ships-as-an-installed-plugin.md)) into repos that are not
  phoenix, and the suppression line above does not ship with it. In the consumer's repo 0279
  preserves the suite for, both plugins can be enabled at once, and `reviewer` / `shipper` then
  contend plugin-against-plugin for one bare `agentType` under the last-write-wins dedup 0195
  records — an exposure the pre-rename `build` / `review` / `ship` did not carry. The nouns are
  ruled; this is the consequence that rides with them, not a reason to re-open the names.
- Whether a user-scope agent directory holds one of the three is a per-machine fact and is not a
  guarantee in either direction. It is checked at adoption, not relied on.

## What this amends in ADR 0255

ADR [0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md) §4 rests its no-collision finding on a
premise about fabrika's plugin root:

> There is no agent-name collision. fabrika ships no agent definitions — its plugin root carries
> `skills/`, `docs/`, `hooks.json` and its manifest, and no `agents/` directory. Nothing contests
> those names.

That premise stopped being true on 2026-08-14, when
[#5586](https://github.com/kamp-us/phoenix/issues/5586) landed `claude-plugins/fabrika/agents/`, and
this decision is what puts two of those definitions on the exact bare names §4 was checking. **This
entry amends 0255 §4 in part**, in that direction only: fabrika does ship agent definitions, and
`reviewer` and `shipper` are contested names wherever both plugins load. Everything else in 0255
stands, including §4's second bullet — `.claude/agents` retired on the same lever as `.claude/skills`,
which is what #5599 did.

The rest of the amendment is arithmetic rather than judgement: with the symlink gone, §4's conclusion
survives its own falsified premise. There is no agent-name collision in phoenix today, but for the
opposite reason to the one §4 gave — not because fabrika ships nothing, but because v1's definitions
no longer load. 0255's body is untouched; its status line carries the link, which is the shape
[0277](0277-v1-retirement-keeps-the-plugin-suppression.md) used for the same act.

## Consequences

1. The name is the spawn target, so the rename has two directions and both were swept.
   **Old names:** nothing in this repo spawned `build`, `review` or `ship` at rename time, and no CI
   job, hook or fabrika verb enumerates the fabrika agent files. A prompt or a driver written outside
   the repo against the old names must be updated by hand.
   **New names — the direction the rename creates:** `.claude/workflows/drive-issue.js` already
   spawns `agentType: "reviewer"` (lines 252, 486, 530) and `agentType: "shipper"` (line 614), left
   from the v1 roster. Those four sites have resolved to three different things in three days, and
   the middle state is the one an earlier draft of this entry got wrong:
   - **Before #5599** they resolved to the v1 definitions themselves —
     `claude-plugins/kampus-pipeline/agents/reviewer.md` and `shipper.md`, materialized at the
     project agent-load path by the `.claude/agents` symlink (0255 §4). That is why the driver spells
     those names at all. Not "no def at all".
   - **After #5599 and before this rename** they resolved to nothing: the symlink was gone and no
     plugin shipped those names.
   - **After this rename**, under 0195's mechanism a bare `name:` is the `agentType` verbatim and
     fabrika is enabled in `.claude/settings.json`, so they resolve to fabrika's shells — preloading
     `fabrika:review` / `fabrika:ship` against v1 prompts and v1 output schemas.

   The two `agentType: "coder"` sites (382, 562) resolve to nothing now, and this rename does not
   change that: fabrika ships no `coder` shell. Whether that driver is on a live path was **not**
   tested here, and this entry does not claim any of it is harmless; it names what resolves to what
   and where.
2. ADR [0280](0280-review-shell-carries-the-spawn-tool.md) is `accepted` and names the `review`
   shell in its title and body. Per the ADR-immutability convention it is not edited; its `review`
   shell is this decision's `reviewer`, and the tool grant it decides is unchanged.
3. The fabrika-local restatement lives in
   [`claude-plugins/fabrika/docs/agent-shells.md`](../claude-plugins/fabrika/docs/agent-shells.md),
   which a future shell author reads before naming a fourth, and points back here for the rule.

## Records

- Records the founder ruling of 2026-08-15, verbatim: *"i think we need to make sure when we are
  naming agents we should name them as nouns, not verbs. so not build, but builder, etc etc."*
- Amends in part [0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md) — §4's *"fabrika ships no
  agent definitions"* premise only. 0255's status line carries the link; its body is untouched.
- Implemented by [#5617](https://github.com/kamp-us/phoenix/issues/5617), over the shells landed by
  [#5586](https://github.com/kamp-us/phoenix/issues/5586) and amended by
  [#5608](https://github.com/kamp-us/phoenix/issues/5608).
- No vocabulary impact. `agent shell` is defined in the fabrika doc above and carries no
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) row; this decision coins nothing, and it leaves the
  registered `build` and `review` rows ADR
  [0242](0242-fabrika-skill-nouns-redefine-build-and-review.md) admitted exactly as they are — it
  neither re-characterises them nor rescopes them.
