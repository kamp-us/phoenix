---
id: 0077
title: Phoenix suppresses the pipeline plugin in-repo (skill discovery doubling)
status: accepted
date: 2026-06-16
tags: [skills, plugin, tooling]
---

# 0077 — Phoenix suppresses the pipeline plugin in-repo (skill discovery doubling)

## Context

The pipeline skill suite ships two ways at once:

- **In-repo** — phoenix carries the suite under `skills/` and exposes it for project-scope discovery via the committed `.claude/skills` → `skills/` symlink. This is the dogfooding source: working *inside* phoenix, the bare `report` / `triage` / `plan-epic` / … skills come from here.
- **As a plugin** — the suite is published as `kampus-pipeline@kampus` and installed at user scope, so it is available in every repo as `kampus-pipeline:report` / etc.

Claude Code does **no cross-scope skill dedupe** (anthropics/claude-code#53923). So inside phoenix — the one repo carrying both sources — every pipeline skill surfaces twice in the picker: bare (symlink) **and** `kampus-pipeline:`-prefixed (plugin). This is issue #346; it does not break functionality but it pollutes the picker and makes invocation ambiguous. The doubling is phoenix-only: every other repo sees a single `kampus-pipeline:*` set.

A premise in the original #346 write-up was that `enabledPlugins` is global-only (lives solely in the user-scope `settings.json`, outside the repo), leaving no per-project way to suppress one scope. **That premise is outdated for CLI 2.1.179.** The CLI reads `enabledPlugins` from `allowedSettingSources: ["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`, and project/local settings override user settings. Verified empirically: with `enabledPlugins: { "kampus-pipeline@kampus": false }` in phoenix's `.claude/settings.json`, `claude plugin list` run in-repo reports `kampus-pipeline@kampus … Status: ✘ disabled`, while it stays enabled in every other repo.

This is the boundary decision #346 routed to epic #228 (ADR child #232).

## Decision

Phoenix **suppresses the `kampus-pipeline@kampus` plugin in-repo** via tracked project settings — `.claude/settings.json` with `enabledPlugins: { "kampus-pipeline@kampus": false }`. The committed `.claude/skills` → `skills/` symlink remains the **canonical in-repo discovery source**; the symlink (layout work #231) is unchanged.

The same in-repo discovery mechanism now covers the plugin's **agents** too: a committed `.claude/agents` → `claude-plugins/kampus-pipeline/agents` symlink surfaces the suppressed plugin's agent definitions (e.g. `coder`) for project-scope discovery and dogfooding, exactly as `.claude/skills` does for skills (#1185).

This is disposition **(b)** of #346 — keep local discovery, disable the redundant plugin in-repo — chosen over:

- **(a) Drop local `.claude/skills` discovery and rely solely on the plugin in-repo.** Rejected: it breaks contributors who have not installed the plugin, and discards the dogfooding source that makes phoenix exercise its own suite.
- **(c) Accept the doubles until upstream ships per-project plugin toggles.** Rejected: the per-project toggle already works in 2.1.179, so there is nothing to wait for.

Implemented by PR #485.

## Consequences

- Inside phoenix, each pipeline skill has a single picker entry again (the bare name from the symlink); the `kampus-pipeline:*` entries are suppressed.
- The setting is **tracked** (not `.claude/settings.local.json`), so every phoenix contributor who installed the plugin gets the dedupe without per-dev configuration.
- For contributors who never installed the plugin, the entry is a harmless no-op — the CLI skips orphaned `enabledPlugins` entries.
- The fix is contained to phoenix and needs no change to the symlink (#231) and no upstream fix; it depends on the project-settings `enabledPlugins` override remaining honored (CLI ≥ 2.1.179).
- `.claude/settings.json` is control plane (ADR 0053): this change is human-merged, not auto-merged by the pipeline.
- If phoenix ever stops shipping the suite in-repo (drops the symlink), this suppression must be removed in the same change so the plugin becomes the in-repo source again.
