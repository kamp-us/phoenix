---
id: 0087
title: A multi-plugin marketplace: each plugin in its own `claude-plugins/<name>` subdir source
status: accepted
date: 2026-06-18
tags: [plugin-portability, packaging, distribution]
---

# 0087 — A multi-plugin marketplace: each plugin in its own `claude-plugins/<name>` subdir source

## Context

`.claude-plugin/marketplace.json` set the `kampus-pipeline` plugin's `source` to `"./"`
(the repo root). `claude plugin install kampus-pipeline@kampus` therefore copied the
**entire phoenix monorepo** into the plugin cache — `apps/`, `packages/`, `infra/`,
`patches/`, lockfiles, `turbo.json`, `biome.jsonc`, and the repo's own `CLAUDE.md` — when
the plugin registers only the `skills/` tree (#484). The plugin **functioned correctly**;
this was packaging bloat: disk per install, and a stray repo `CLAUDE.md` + unrelated source
shipped to every consumer.

Two forces pointed the same way. **Packaging:** the reporter named three candidate
dispositions — (a) a dedicated subdirectory + subdir `source`; (b) an ignore mechanism
keeping `"./"`; (c) accept the bloat as harmless. **Marketplace shape:** a `kamp.us`
marketplace will host **more than one plugin** over time, and a single plugin pinned at the
repo root can't grow into that — a real marketplace needs a place to put plugin #2.

We confirmed against the Claude Code plugin/marketplace docs and real-world marketplaces:

1. **No ignore mechanism exists.** `.claudeignore`, `.gitignore`, an `exclude`/`files`
   field in `plugin.json`/`marketplace.json` — none filter what plugin packaging copies. So
   (b) is not available.
2. **A relative/local `source` is a full recursive directory copy** — not a `git archive`
   of tracked files, not filtered. `"./"` always copies everything under the root.
3. **`source` supports a subdirectory** — a relative `"./claude-plugins/kampus-pipeline"`
   (copies only that subtree) or the object `git-subdir` form. This is the established fix
   (e.g. `pbakaus/impeccable` shrank ~380× moving `"./"` → a subdir), and the official
   marketplace's monorepo plugins prefer it.

So (a) is the only mechanism that actually trims the distributed tree — and a per-plugin
subdir is exactly the shape a multi-plugin marketplace needs anyway.

## Decision

**Adopt (a), structured as a proper multi-plugin marketplace: a `claude-plugins/` container,
one subdir per plugin, each distributed from its own subdir source.**

1. **Layout.** The repo-root `.claude-plugin/marketplace.json` (the catalog) stays at the
   root and lists each plugin with its own `source`. `claude-plugins/` is the **container**;
   each plugin lives in `claude-plugins/<name>/` holding its `.claude-plugin/plugin.json` +
   `skills/`. Today: `claude-plugins/kampus-pipeline/`, with
   `"source": "./claude-plugins/kampus-pipeline"`. A plugin's subdir is the **only** tree its
   install receives — `apps/`, `packages/`, `infra/`, lockfiles, and the repo `CLAUDE.md` are
   no longer shipped. Adding plugin #2 is a sibling `claude-plugins/<other>/` + one catalog entry.

2. **The local-discovery symlink retargets** from `.claude/skills → ../skills` to
   `.claude/skills → ../claude-plugins/kampus-pipeline/skills` (relative, mode-`120000`,
   clone-safe). Phoenix's own `.claude/skills/` discovery and the CI validators
   (`bash .claude/skills/validate-skills.sh`, run **through the symlink**) are unchanged — no
   workflow edit needed. The "one canonical home, no duplicated content" invariant (ADR
   [0062](0062-repo-as-config-plugin.md) §5 layout) holds, with the home now at
   `claude-plugins/kampus-pipeline/skills/`.

3. **External doc-references become permalinks, not relative paths.** Moving the tree a level
   deeper would re-break any skill that linked `.decisions/`/`.patterns/` relatively; those
   refs are rewritten to stable phoenix GitHub permalinks (the ADR 0062 §4 convention), which
   is also what makes them resolve from an adopter's install where those trees don't exist.

## Consequences

- **Installs carry only the plugin's own subtree** — no monorepo source, no stray `CLAUDE.md`,
  far less disk per consumer.
- **The marketplace can grow** — a second `kamp.us` plugin is a sibling
  `claude-plugins/<name>/` plus a catalog entry, with no repo-root reshuffle. The layout is
  the marketplace shape, not a one-plugin special case.
- **Sibling marketplaces** (`usirin-skills`, `agent-review-panel`) share the same `"./"`
  whole-repo-copy property; this ADR is the pattern they should follow, but restructuring
  them is out of scope here (each owns its own move).
- **The `claude-plugins/<name>/` indirection is a small cost** — a deeper path for skill
  files and a retargeted symlink — paid once, against a per-install bloat saved forever.
- **No ignore-file escape hatch** means any future "don't ship X" need is met by keeping X
  outside `claude-plugins/`, not by an allowlist — the subdir boundary *is* the allowlist.
- **Relates to:** ADR [0062](0062-repo-as-config-plugin.md) (repo-as-config; §4 permalink convention, §5 layout/symlink), and the foreign-repo-hardening front #592 (manifest drift), #425 (ship-it degradation), #460 (preflight doctor).
