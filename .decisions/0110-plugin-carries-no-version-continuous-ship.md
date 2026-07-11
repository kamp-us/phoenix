---
id: 0110
title: The kampus-pipeline plugin carries no `version` — continuous-ship, content-addressed by commit SHA
status: accepted
date: 2026-06-27
tags: [plugin-portability, packaging, distribution, pipeline]
---

# 0110 — The kampus-pipeline plugin carries no `version` — continuous-ship, content-addressed by commit SHA

## Context

The plugin manifest [`claude-plugins/kampus-pipeline/.claude-plugin/plugin.json`](../claude-plugins/kampus-pipeline/.claude-plugin/plugin.json)
has no `version` field, and the marketplace plugin entry in
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) carries none either.
A structural plugin audit reads the omission as a defect ("a plugin manifest should declare a
version") and re-files it — it has been filed at least once as a bug (#1184), and an undocumented
deliberate decision is indistinguishable from a bug, so every fresh validator and every fresh agent
will re-read it as one and re-file it.

The omission is **deliberate**, and the cost of the alternative is not hypothetical — it was paid:
**#945** pinned the plugin at `0.1.0`, which **froze the Claude Code install cache**. Claude Code
keyed the cached install on that semver, so skill additions and edits committed afterward **never
reached already-installed users** — they silently kept serving stale skills until the pin was
removed. The version field actively fought the way this plugin is meant to ship.

The pin also has no audience. This plugin is **not** a published npm-style package consumed at a
chosen release; it is distributed from a git source (`"source": "./claude-plugins/kampus-pipeline"`,
ADR [0087](0087-plugin-dedicated-subdir-source.md)) and installed by a consumer who points Claude
Code at the repo. With **no** version, Claude Code **content-addresses the install by git commit
SHA** — every commit on the tracked ref is itself a distinct "version", and an edit reaches installed
users on the normal update path the moment it lands. That is the continuous-ship posture this
repo-as-config plugin already lives by (ADR [0062](0062-repo-as-config-plugin.md)): the source ref
*is* the release channel, with no separate semver cadence to bump, gate, or get wrong.

(The `metadata.version` on the **marketplace catalog** in `marketplace.json` is a different field —
it versions the catalog document, not the plugin's served content — and is out of scope here.)

## Decision

**The kampus-pipeline plugin deliberately carries no `version` field — neither in
`plugin.json` nor in its `marketplace.json` plugin entry — and none is to be added.** The
plugin ships continuously: consumers track the source ref, Claude Code content-addresses each
install by git commit SHA, and every commit is the new "version".

- A `write-code` agent (or any contributor) that finds the missing `version` **must not "fix" it
  by adding one** — doing so re-introduces the #945 cache-freeze and breaks the continuous-ship
  contract. The absence is the correct state.
- Because `plugin.json` is strict JSON (no comments), the rationale cannot live inline in the
  manifest. The builder-facing note lives in
  [`claude-plugins/kampus-pipeline/README.md`](../claude-plugins/kampus-pipeline/README.md),
  which points at this ADR for the why + history; this ADR is the canonical decision record.

## Consequences

- **Skill edits reach installed users immediately** — on the next update against the tracked ref,
  with no version bump to remember and no cache to invalidate by hand. This is the property #945
  destroyed and this ADR protects.
- **The recurring false-positive is immunized.** A validator or fresh agent that flags the missing
  `version` now has a decision record to read; the disposition is "documented intentional", not
  "open defect to re-file".
- **No semver surface to maintain** — no changelog cadence, no release gate, no version-skew matrix
  between the manifest and the catalog. The continuous-ship model trades a release ceremony for the
  discipline that every commit on the tracked ref is shippable (the same bar the review gates already
  enforce).
- **The trade-off:** consumers cannot pin to a frozen plugin release — they get whatever the tracked
  ref currently holds. That is acceptable and intended for an in-house, agent-operated pipeline whose
  authors and consumers are the same org; it is **not** a model to copy blindly for a plugin with
  external consumers who need a stable pin.
- **Relates to:** ADR [0062](0062-repo-as-config-plugin.md) (repo-as-config / continuous-ship
  posture), ADR [0087](0087-plugin-dedicated-subdir-source.md) (git-subdir plugin source), and #945
  (the version-pin cache-freeze incident this decision exists to prevent recurring).
