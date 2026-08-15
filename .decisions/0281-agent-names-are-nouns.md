---
id: 0281
title: Agent names are nouns
status: accepted
date: 2026-08-15
tags: [pipeline, fabrika, agents, naming]
---

# 0281 — Agent names are nouns

**What this decides:** every agent definition in this repo is named for the thing that acts, not for
the act. `builder`, `reviewer`, `shipper` — never `build`, `review`, `ship`. Skills keep their verbs.

## Context

The three fabrika agent shells landed on 2026-08-14 named `build`, `review` and `ship`
([#5586](https://github.com/kamp-us/phoenix/issues/5586)), each with a `skills:` preload naming the
same-spelled skill. So `claude-plugins/fabrika/agents/review.md` carried `name: review` and
`skills: ["fabrika:review"]`, and the seat and the instructions it loads became one string.

That string is ambiguous everywhere it is read. In a prompt, in a workflow script's `agentType`, and
in a log line, `fabrika:review` is either the skill or the shell and nothing distinguishes them.
`fabrika:reviewer` spawning `fabrika:review` reads in one pass.

The name also misdescribes what a shell is. A shell carries no behaviour by design
([`claude-plugins/fabrika/docs/agent-shells.md`](../claude-plugins/fabrika/docs/agent-shells.md),
"A shell that grows opinions is a defect"), and an imperative name reads as a command — an invitation
to the exact misreading that rule exists to prevent.

## Decision

**An agent's `name:` is a noun — the actor, never the action.**

- It binds every agent definition in this repo, not only the three fabrika shells, and it binds the
  fourth shell nobody has written yet.
- Skills are unaffected: `fabrika:build`, `fabrika:review` and `fabrika:ship` stay verbs. A skill is
  a set of instructions — an act. The pair reads `fabrika:builder` runs `fabrika:build`.
- The three shells are renamed `builder`, `reviewer`, `shipper`, filename and `name:` frontmatter
  together, since the doc treats them as a matched pair.

**Banned.** An agent definition whose `name:` is the bare verb of the skill it preloads. Renaming a
skill to a noun to resolve the collision from the other side.

## The collision check this rests on

ADR [0195](0195-crew-agent-def-name-collision-free-convention.md) records that under Claude Code
2.1.214 a bare `name:` became the def's `agentType` verbatim with no plugin-namespace prefix, so a
same-named user-scope def shadowed the plugin def under last-write-wins dedup. Its fix — the
`crew-<role>` prefix — is a convention local to the crew plugin, not a repo-wide naming law, so it
does not conflict with this one.

`builder` / `reviewer` / `shipper` were checked against that mechanism before being adopted:

- `claude-plugins/kampus-pipeline/agents/reviewer.md` and `shipper.md` already carry two of these
  names, but that plugin is disabled in `.claude/settings.json`
  (`"kampus-pipeline@kampus": false`) and is retired in full by ADR
  [0279](0279-v1-crew-retired-in-full.md), so it contributes no definitions to load.
- Whether a user-scope agent directory holds one of the three is a per-machine fact and is not a
  guarantee in either direction. It is checked at adoption, not relied on.

## Consequences

1. Anything that spawns a shell by its old name breaks — the name is the spawn target. Nothing in
   this repo did at rename time: `.claude/workflows/drive-issue.js` spawns only the v1 names
   (`planner`, `coder`, `reviewer`, `shipper`, `adr`), and no CI job, hook or fabrika verb enumerates
   the fabrika agent files. A prompt or a driver written outside the repo against the old names must
   be updated by hand.
2. ADR [0280](0280-review-shell-carries-the-spawn-tool.md) is `accepted` and names the `review`
   shell in its title and body. Per the ADR-immutability convention it is not edited; its `review`
   shell is this decision's `reviewer`, and the tool grant it decides is unchanged.
3. The fabrika-local restatement lives in
   [`claude-plugins/fabrika/docs/agent-shells.md`](../claude-plugins/fabrika/docs/agent-shells.md),
   which a future shell author reads before naming a fourth, and points back here for the rule.

## Records

- Records the founder ruling of 2026-08-15, verbatim: *"i think we need to make sure when we are
  naming agents we should name them as nouns, not verbs. so not build, but builder, etc etc."*
- Implemented by [#5617](https://github.com/kamp-us/phoenix/issues/5617), over the shells landed by
  [#5586](https://github.com/kamp-us/phoenix/issues/5586) and amended by
  [#5608](https://github.com/kamp-us/phoenix/issues/5608).
- No vocabulary impact. `agent shell` is defined in the fabrika doc above and carries no
  [`.glossary/TERMS.md`](../.glossary/TERMS.md) row; this decision coins nothing.
