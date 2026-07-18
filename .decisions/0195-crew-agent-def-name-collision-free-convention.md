---
id: 0195
title: Crew agent-def `name:` carries the collision-free `crew-<role>` convention; the bare role keys everything else
status: accepted
date: 2026-07-18
tags: [pipeline, pipeline-crew, crew-mcp, roster, naming]
---

# 0195 — Crew agent-def `name:` carries the collision-free `crew-<role>` convention; the bare role keys everything else

**What this decides:** The crew's four plugin agent-defs are named `crew-<role>` (e.g. `crew-cartographer`), not the bare role, and the launcher boots each pane with `--agent crew-<role>`; every other place that names a role — `CREW_ROLES`, the channel role map, model tiering, `--name`/session identity — still uses the **bare** role. This amends the naming detail of ADR 0189's roster law; the roster law itself is unchanged.

## Context

Amends [0189](0189-crew-roster-law-bridges-engines.md). ADR 0189 fixed the crew roster as
four bare-role slugs (`chief-of-staff` / `cartographer` / `intake-desk` /
`engineering-manager`) and had the plugin agent-defs named by those bare roles, so the role
slug and the agent-def `name:` frontmatter were one identity map and the launcher passed the
role verbatim as its `--agent` argument.

That identity map turned out to be unsafe at the agent-def name specifically. `claude`'s
agent-pool dedup (2.1.214) is **last-write-wins with userSettings applied after plugins**, and
a bare `name:` frontmatter becomes the def's `agentType` **verbatim, with no plugin-namespace
prefix**. So a personal user-scope agent def (one that lives in the CLI's user-level config
directory rather than the project's `.claude/`) with the same bare name **shadows** the
plugin def, and `--agent <bare-role>` boots the personal persona instead of the crew one — while
the plugin-qualified `--agent plugin:name` form does **not** resolve. This is the #3447
collision; it was fixed by renaming the plugin defs and the launcher argv in PR #3477.

Per the ADR-immutability convention a landed `accepted` ADR is not edited in place — this
correction is recorded as a short amending ADR rather than a rewrite of 0189's text.

## Decision

**The plugin agent-def `name:` frontmatter carries the collision-free `crew-<role>` convention; the bare role remains the key everywhere else.**

- The four `claude-plugins/pipeline-crew/agents/` defs are named `crew-cartographer`,
  `crew-intake-desk`, `crew-chief-of-staff`, `crew-engineering-manager` — the bare role prefixed
  with `crew-`. This is the one place a bare name would collide with a personal def, so it is the
  one place the name is transformed.
- The stand-up launcher maps the bare role to `crew-<role>` **at the argv site** and emits
  `--agent crew-<role>` (grounded in `packages/pipeline-crew-mcp/src/standup/bind.ts`, `AGENT_FLAG`
  + the launch-inputs docblock, #3447).
- Everything else keys on the **bare** role, unchanged: `CREW_ROLES`
  (`packages/pipeline-crew-mcp/src/crew/roles.ts`), the channel role map, model tiering, and the
  `--name`/session identity (a bridge is the bare singleton role; an engine is `role-<instance>`).

So the role→agent-def mapping is **not** a whole identity map, and the `--agent` argument is **not**
the role verbatim — both claims held before #3447 and are corrected here. The invariant to carry
forward is: **bare role everywhere except the agent-def `name:` frontmatter, which carries the
collision-free `crew-<role>` plugin-name convention** (adopted because a same-named personal def
shadows the plugin def under last-write-wins agent-pool dedup, and `--agent plugin:name` does not
resolve).

## Consequences

- A future reader grounding a change in ADR 0189 no longer carries the stale "identity map /
  verbatim `--agent`" model. The single mental transform is: agent-def name is `crew-<role>`;
  bare role everywhere else.
- Adding a role to the roster means adding a `crew-<role>`-named plugin agent-def **and** its bare
  role in `CREW_ROLES` / the channel map / tiering — the two names for the same role, kept in sync
  by the `bind.ts` argv-site mapping.
- 0189's roster law (three bridges + an engine pool, cardinality-from-kind, flat topology) is
  untouched — this amends only the role↔agent-def naming detail beneath it.

## Records

- Amends [0189](0189-crew-roster-law-bridges-engines.md) (roster law); records the collision-free
  agent-def naming convention landed by #3447 / PR #3477. Closes #3478.
- No new `.glossary/TERMS.md` term: `crew-<role>` is a mechanical launcher/plugin naming convention
  local to the crew, not a shared architecture or product noun. No vocabulary impact.
