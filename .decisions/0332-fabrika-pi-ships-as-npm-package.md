---
id: 0332
title: fabrika for pi ships as the npm package @kampus/fabrika-pi — release-time bundled, pinned
status: accepted
date: 2026-08-21
tags: [fabrika, pi, packaging, distribution, publishing]
---

# 0332 — fabrika for pi ships as the npm package @kampus/fabrika-pi — release-time bundled, pinned

**What this decides:** the channel that carries fabrika to a pi user outside this repository is an
npm package — `@kampus/fabrika-pi`, release-time bundled from this monorepo, versioned by
release-please — not a git-source install of phoenix.

This transcribes the founder ruling recorded on
[#6970](https://github.com/kamp-us/phoenix/issues/6970#issuecomment-5375996622) (2026-08-21). The
research that collapsed the field to one question is that issue's body; this record adds only the
choice and its mechanics.

## Context

Fabrika's pi wiring (`.pi/settings.json`, `.pi/agents/`) exists only inside this repository, so a
project running pi cannot consume fabrika today. Pi has a native package channel (`pi install`
accepts npm specs, git URLs and local paths), so two shapes were live candidates:

1. **npm package** — mirror the opencode twin ([PR #6967](https://github.com/kamp-us/phoenix/pull/6967)):
   publish `@kampus/<name>`, bundle skills at release time, ride the existing release machinery
   ([`.patterns/release-path.md`](../.patterns/release-path.md)).
2. **git-source install** — `pi install git:kamp-us/phoenix` with a root `pi` manifest pointing at
   `claude-plugins/fabrika/skills/` directly; zero registry, zero release ceremony.

ADR [0110](0110-plugin-carries-no-version-continuous-ship.md) ruled continuous-ship for the
in-repo Claude Code plugin but flagged its own limit: that model is *"not … to copy blindly for a
plugin with external consumers who need a stable pin."* Which side of that caveat the pi artifact
lands on was the open question. Neither ADR [0273](0273-fabrika-ships-as-an-installed-plugin.md)
nor 0110 names a pi channel.

## Decision

**`@kampus/fabrika-pi` is published to npm as a release-time bundle of this monorepo, and the
git-source install of phoenix is rejected as the distribution channel.**

- **Rejected alternative, recorded:** git-source install loses because a git install of phoenix
  drags the whole monorepo to every consumer, and the prototype showed an npm-style install of this
  tree crashing on workspace `catalog:` dependencies — the resolution pi's installer performs does
  not speak pnpm catalog refs. Fixing that means making the root installable as a package, which is
  monorepo-wide drag bought for one consumer channel.
- **What the artifact exposes for skills:** the same release-time copy the opencode twin uses —
  `claude-plugins/fabrika/skills/` is bundled into the published package (`dist/skills/`) by a
  sync script at build/release time, and the package's `pi.skills` manifest key points there. Skills
  are standard SKILL.md files, so they load natively with no transform.
- **What the artifact exposes for agent shells:** shells target the **pi-subagents manifest
  convention** — the `pi.subagents.agents` key read from an installed package's manifest by the
  third-party subagent extension ([nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)),
  which is the dominant convention among published pi packages. The integration is declared by that
  manifest convention plus README documentation only — shells require pi-subagents, all skills work
  without it — and never as a dependency of any kind, runtime or peer.
- **Dependencies:** `peerDependencies` carry pi core modules only (`@earendil-works/*`, `typebox`)
  at `"*"` ranges, left unbundled — and only those the bundle actually imports.
- **Versioning:** the package is versioned by release-please and lands through the documented
  third-package procedure in [`release-path.md`](../.patterns/release-path.md) § "Adding a third
  published package" (resolve arm, release-please root, human bootstrap publish, Trusted Publisher).

### The ADR 0110 caveat, resolved

Consumers of `@kampus/fabrika-pi` get **pinned versions**, not continuous-ship updates — the
semver-ceremony trade ADR 0110's caveat anticipated, accepted here deliberately: an external
consumer updating against `@kampus/fabrika-pi@x.y.z` needs a stable pin to reason about skill
content drift, and npm's update path delivers releases exactly when release-please cuts them.
Continuous-ship remains scoped to what ADR 0110 actually governed — the in-repo Claude Code plugin,
content-addressed by commit SHA. The two artifacts ship different trades on purpose; neither
amends the other's posture.

## Consequences

- An external pi user installs fabrika with one npm spec (`pi install npm:@kampus/fabrika-pi`) and
  a manifest line, the same shape the opencode twin established — no fork of conventions across
  harnesses.
- Skill edits reach external consumers only on a release, not on commit — the cost of the pin, and
  the reason the release-time sync script must refuse to bundle zero skills (mirroring #6967's
  fail-closed guard).
- One more package joins the release matrix: a resolve arm, a release-please root, a human
  bootstrap publish, and a Trusted Publisher registration before any CI publish goes green.
- If pi ever grows native subagent support in the core `pi` manifest key, the pi-subagents targeting
  clause above is revisited; until then the ecosystem convention is the interface.
