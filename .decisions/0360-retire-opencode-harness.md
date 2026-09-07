---
id: 0360
title: Claude Code and pi are fabrika's only harnesses, never opencode
status: accepted
date: 2026-09-07
tags: [fabrika, harness, opencode, packaging, retirement]
---

# 0360 — Claude Code and pi are fabrika's only harnesses, never opencode

**What this decides:** opencode is no longer a harness fabrika supports. Its package, its agent
shells, its config, its release wiring and its catalog dependencies are deleted from this
repository, and nothing in the tree may point at it again.

Founder ruling of 2026-09-06 (PT), transcribed on
[#8457](https://github.com/kamp-us/phoenix/issues/8457): *"i wanna get rid of whatever we have for
opencode. that harness sucks."* — then, asked whether that reached the package, the shells, the
config and the release wiring: *"yes, all of it, go."*

## Context

fabrika grew a third harness alongside Claude Code and pi: an `@kampus/fabrika-opencode` npm
package, eight agent shells under `.opencode/agent/`, a session-stamping plugin, a root
`opencode.json`, two `@opencode-ai/*` catalog entries, and arms in every release and publish
workflow. ADR [0332](0332-fabrika-pi-ships-as-npm-package.md) built the pi package by mirroring that
one, which is why the opencode twin is named throughout it as the shape to copy.

Nobody runs the fleet on opencode. What the wiring still produces is cost: release-please cuts bot
PRs for a package with no consumer, the publish workflow carries a tag arm nobody triggers, and
`.opencode/agent/` holds a second copy of every shell that drifts from `.claude/agents/` the moment
one is edited. The first of those costs is not hypothetical: release-please has cut
`chore(main): release fabrika-opencode 0.2.0` twice — [#7266](https://github.com/kamp-us/phoenix/pull/7266),
then [#8458](https://github.com/kamp-us/phoenix/pull/8458) once #7266 was closed — and it re-mints
that Release PR on every qualifying push for as long as the package root stays in the release
config.

Half-removed is the state worth avoiding: a stale shell or a dangling release-please path keeps
generating work for a harness nobody uses, and a reader cannot tell an unfinished migration from a
supported one.

## Decision

**opencode is retired as a fabrika harness, and every trace of it leaves this repository in one
change.**

Deleted: `packages/fabrika-opencode/`, `.opencode/`, `opencode.json`, the `fabrika-opencode`
entries in `release-please-config.json` and `.release-please-manifest.json`, the
`fabrika-opencode-v` tag arm in `publish.yml`, the `FABRIKA_OPENCODE_TAG` outputs and
`release_created` conditions in `release-please.yml`, and the `@opencode-ai/plugin` /
`@opencode-ai/sdk` catalog entries with their lockfile rows.

**Binding constraints.**

- **Two harnesses, named.** fabrika targets Claude Code (`.claude/agents/`, the plugin under
  `claude-plugins/fabrika/`) and pi (`.pi/`, `@kampus/fabrika-pi`). Admitting a third is its own
  decision, not an addition someone makes in passing.
- **No pointer survives its target.** A doc, a docblock or a config key naming opencode is deleted
  with the thing it named. `.decisions/` and `reports/` are the exception and keep their mentions —
  they are history, and history is not swept.
- **The published package is deprecated, never unpublished.** `@kampus/fabrika-opencode@0.1.0` is
  on npm and stays there; unpublishing breaks any lockfile that ever resolved it. Deprecating it is
  a founder action against the registry, outside this repository.
- **`FABRIKA_SESSION_ID` stays in the session-id chain.** It was the escape hatch opencode needed
  because opencode exposes no session id, but it is a harness-neutral override, and removing it
  would strip a working seam from harnesses that still use it.

## Consequences

- The release matrix drops to two published packages, `@kampus/fabrika-cli` and
  `@kampus/fabrika-pi`. `.patterns/release-path.md` describes two arms, not three.
- Agent shells have one home per supported harness and no third copy to keep in sync. ADR
  [0311](0311-every-agent-shell-carries-the-spawn-tool.md)'s every-shell rule is unchanged; it now
  ranges over fewer shells.
- ADRs [0331](0331-fabrika-spawn-hook-retired.md) and
  [0332](0332-fabrika-pi-ships-as-npm-package.md) are amended in part by this record. Both rulings
  stand whole — 0331 still deletes the spawn hook, 0332 still ships `@kampus/fabrika-pi` on npm —
  but each rests part of its reasoning on opencode being a harness the fleet runs, and that half is
  no longer true. Only their `status:` lines change — the bodies are byte-identical, and this
  record is where the correction lives.
- [#8049](https://github.com/kamp-us/phoenix/issues/8049),
  [#7329](https://github.com/kamp-us/phoenix/issues/7329),
  [#6991](https://github.com/kamp-us/phoenix/issues/6991) and
  [#6973](https://github.com/kamp-us/phoenix/issues/6973) are opencode-symptom tickets that stop
  being live with this record. Closing them is triage's call, not this change's.
- An operator who was running fabrika on opencode has no supported path. That cost is accepted:
  the ruling is that nobody is.

## Records

no vocabulary impact
