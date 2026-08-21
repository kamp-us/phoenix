---
id: 0319
title: A shell composes stage skills through its skills list, never by splitting the ticket
status: accepted
date: 2026-08-21
tags: [fabrika, agents, skills, routing]
---

# 0319 — A shell composes stage skills through its skills list, never by splitting the ticket

**What this decides:** when one ticket spans two construction laws (text code and rendered UI), one agent carries both skills and builds the whole ticket; the work is never split into two tickets, and no skill invokes another skill mid-run to cover the gap.

## Context

The UI lane (ADR 0317) split construction into `build` (text) and `build-ui` (rendered surfaces, which must read the design manifest before generating and prove their work through a render harness). Each skill declares the other's domain out of its lane. A ticket whose deliverable spans both — a new API plus the screen that uses it — then has no clean owner.

Three shapes were considered on 2026-08-20 and the founder rejected two by name:

- **Rejected: splitting the ticket** (at triage, or mid-build when the builder discovers pixels). An API without its screen is dead code on main; a screen without its API is a mock. Splitting half-lands a feature and makes the second builder rediscover the first one's context.
- **Rejected: `build` invoking the `build-ui` skill mid-run.** That puts a routing decision inside a shell, and routing lives in the lane machine. It also turns a stage skill into an orchestrator.
- **Ruled: composition via the shell's `skills:` preload list.** `build-ui` already shares the `build` group's lane verbs verbatim, so the two laws are complementary; what a shell can do is exactly the union of the skills it preloads.

Ruling relayed on [#6768](https://github.com/kamp-us/phoenix/issues/6768#issuecomment-5364929119) (the class-seed gap that motivates the routing half).

## Decision

**A fabrika shell's `skills:` frontmatter list is its capability set: a shell may preload more than one stage skill, and a mixed-deliverable ticket routes whole to a shell whose list covers every law the diff needs.**

Mechanics:

- The lane machine stays the router. The class seeded at triage (#6768) decides which shell the build cell spawns; a wrong seed re-routes at build (the builder records BLOCKED and the lane re-spawns the right shell). The diff is never split across tickets to fit a shell.
- Co-loaded skills need composition clauses. Each stage skill that names another skill's domain out of its lane must state what holds when both are loaded: the diff's class picks the law per file, and the manifest read stays mandatory before any ui-class file is touched. Without the clause, the two lane-exclusions read as a contradiction under co-load.
- Self-routing is not the guard. An agent with both skills loaded is not trusted to notice the boundary on its own — lane 6660's builder under-routed exactly this way. The seed routes; the skills govern construction; the review gates (which derive per-namespace from the actual diff, not from who built) catch what slips.
- Review is unchanged. A mixed PR owes both `review-code` and `review-ui`, whoever built it.

**Binding constraints.**
- Never split a ticket to fit a single-skill shell.
- Never have a stage skill invoke another stage skill mid-run to cover a construction law it lacks.
- A skill that excludes a domain from its lane must carry a composition clause before it is co-loaded with that domain's skill.

## Consequences

- Mixed tickets land as one PR under one agent; the heavier context (two skills plus contracts) is the accepted cost, proven workable by the reviewer carrying `review` + `review-ui` in one context on PR #6756 and #6780.
- `ui-builder` remains the fast path for pure-UI tickets; a both-skills builder shell covers the mixed case without a hand-authored superset skill.
- The composition clauses are new prose owed to `build` and `build-ui` (filed as a build ticket alongside this ADR); until they land, co-loading reads contradictory and should not be wired.

## Records

no vocabulary impact
