---
id: 0411
title: Phoenix drops the kampus-pipeline marketplace entry and its settings suppression
status: accepted
date: 2026-09-26
tags: [pipeline, fabrika, plugin, retirement]
---

# 0411 — Phoenix drops the kampus-pipeline marketplace entry and its settings suppression

**What this decides:** the retired v1 plugin is no longer offered by the `kampus` marketplace, and
the `.claude/settings.json` line that disabled it goes too, because there is nothing left for it to
disable.

## Context

**Amends in part [0303](0303-retire-kampus-pipeline-plugin.md) and
[0277](0277-v1-retirement-keeps-the-plugin-suppression.md)** — each keeps its decision text, and its
status line records the amendment.

ADR 0303 deleted the `kampus-pipeline` tree but kept two things on purpose. Its Decision kept the
`kampus-pipeline` object in `.claude-plugin/marketplace.json`, a `git-subdir` source pinned to sha
`633d61e5913f7666178e0bb4a7fe1a89b5c206fd`, so the v1 roster stayed installable out of history. Its
"What went with the tree" section kept `"kampus-pipeline@kampus": false` beside it, on the grounds
that ADR 0277 bans removing the suppression and the pinned entry gives it something to suppress.

ADR 0277 kept the suppression line when v1 retired, so the v1 roster could not come back on a
machine that later installs the plugin. Its binding constraints say the line stays through
retirement and after it, and its Banned list forbids removing it as part of retiring v1.

In practice the pinned entry offers a dead pipeline next to `fabrika` to anyone who adds the
`kampus` marketplace, and it still installs from that old commit.

Founder ruling, 2026-09-26, on
[#9814](https://github.com/kamp-us/phoenix/issues/9814#issuecomment-5850426771): reverse the keep
rulings in ADR 0303 ([#5937](https://github.com/kamp-us/phoenix/issues/5937)) and ADR 0277
([#5532](https://github.com/kamp-us/phoenix/issues/5532)) and remove both entries. Verbatim on its
operative words: *"yeah, reverse it and remove it."* The reason given: fabrika is the only
pipeline, and once the marketplace entry is gone the suppression has nothing left to block.

## Decision

**The sha-pinned `kampus-pipeline` marketplace entry and the `"kampus-pipeline@kampus": false`
suppression are both removed.**

`.claude-plugin/marketplace.json` lists `fabrika` as its only plugin. `.claude/settings.json`
`enabledPlugins` names `fabrika@kampus` only.

What this reverses:

| Record | Clause | now reads |
|---|---|---|
| 0303, Decision, second paragraph | the `kampus-pipeline` marketplace entry stays and survives the deletion verbatim | the entry is removed |
| 0303, "What went with the tree", first bullet | the sha-pinned entry stays, and with it `"kampus-pipeline@kampus": false` | both are removed |
| 0277, Decision | keep the `"kampus-pipeline@kampus": false` suppression at v1 retirement | the suppression is removed |
| 0277, Binding constraints, second bullet | the suppression stays through retirement and after it | the suppression does not stay |
| 0277, Banned, first bullet | removing the suppression as part of retiring v1 is banned | removing it is the required act |

Everything else in 0303 and 0277 stands: the v1 tree stays deleted, and both `.claude` symlinks stay
deleted.

The suppression and the entry go together because the entry was the suppression's only remaining
reason. With no `kampus` marketplace entry, `kampus-pipeline@kampus` cannot be installed from this
repo's marketplace, so the line would guard a door that no longer exists.

**Binding constraints.**

- `.claude-plugin/marketplace.json` does not list `kampus-pipeline` from any source or commit.
- `.claude/settings.json` does not carry a `kampus-pipeline@kampus` key.

**Banned.**

- Citing ADR 0303's keep of the marketplace entry, or ADR 0277's keep of the suppression, as live.
- Re-adding the pinned entry to serve the v1 roster out of history.

## Consequences

- Adding the `kampus` marketplace offers `fabrika` alone.
- A machine that already installed `kampus-pipeline` from the old pinned entry no longer has it
  disabled inside phoenix. That machine's owner uninstalls it; phoenix no longer guards against it.
- ADR [0077](0077-in-repo-pipeline-skill-discovery-doubling.md)'s decision, suppressing the plugin
  in-repo, loses its one remaining mechanism, the line this record removes. Its status line is not
  edited here: this change's scope admits status edits to 0303 and 0277 only.

## Records

- Executed by [#9814](https://github.com/kamp-us/phoenix/issues/9814) in the same pull request.
- No vocabulary impact. Nothing is coined or redefined.
