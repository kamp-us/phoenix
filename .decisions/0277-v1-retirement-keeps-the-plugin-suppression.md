---
id: 0277
title: v1 retirement deletes both `.claude` symlinks and keeps the plugin suppression
status: amended-in-part by [0303](0303-retire-kampus-pipeline-plugin.md)
date: 2026-08-13
tags: [skills, plugin, pipeline, fabrika]
---

# 0277 — v1 retirement deletes both `.claude` symlinks and keeps the plugin suppression

**What this decides:** when the v1 skill roster is retired, the two tracked `.claude` symlinks go
and the one line in `.claude/settings.json` that disables the `kampus-pipeline@kampus` plugin
**stays**. ADR 0255 and ADR 0077 both say the suppression must be removed in that same change; that
is the part this entry reverses, and it reverses it because the reason those two entries gave has
stopped being true.

## Context

Two live `accepted` ADRs bind this. **Amends in part [0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md)
and [0077](0077-in-repo-pipeline-skill-discovery-doubling.md)** — each keeps its decision text and
its status line records the amendment.

ADR 0077 (2026-06-16) disabled the published `kampus-pipeline@kampus` plugin inside phoenix so the
pipeline suite would stop appearing twice in one picker, and kept the tracked `.claude/skills`
symlink as the in-repo source. Its final consequence bullet then pinned a follow-on instruction:
*"If phoenix ever stops shipping the suite in-repo (drops the symlink), this suppression must be
removed in the same change so the plugin becomes the in-repo source again."* ADR 0255 (2026-08-10)
carried that instruction forward into the retirement plan, restating it at four sites.

**The premise flip.** 0077's instruction rests on one assumption: that when the symlink goes, the
published plugin is the source you *want* to take over. That was right in June, when the symlink and
the plugin were two copies of the same wanted suite. It is not right now. v1 is not moving houses —
it is being retired outright, with fabrika as its replacement, and fabrika ships as its own installed
plugin (ADR [0273](0273-fabrika-ships-as-an-installed-plugin.md)). So there is nothing the
`kampus-pipeline` plugin is meant to take over.

**The grounding fact.** Verified on the operator machine 2026-08-13: `kampus-pipeline` is not
installed as a plugin at any scope. Removing the suppression today would therefore summon nothing;
it would only leave the door open for the whole v1 roster to reappear on any machine where the
plugin is later installed. Keeping one disabled-plugin line is the cheap way to make retirement mean
retired everywhere.

Founder ruling, direct confirmation, recorded on
[#5532](https://github.com/kamp-us/phoenix/issues/5532) (2026-08-14, verbatim on its operative
words: *"yes, keep the line"*), confirming the earlier ruling on
[#5276](https://github.com/kamp-us/phoenix/issues/5276).

**One qualification is already discharged.** The #5276 ruling asked the implementing lane to confirm
that `false` suppresses the plugin whether or not the symlink is present. ADR 0255's own Consequences
records the measured answer — *"the toggle's scope is the plugin copy and never the symlink"* — so
the two texts never disagreed on the platform behavior, only on the instruction.

**The retirement trigger also lost its measurement.** ADR 0255 §3 gates retirement on *"its eval sets
show its skills fire"*, citing ADR [0249](0249-skill-trigger-coverage-lives-in-the-eval-set.md). The
founder ruled on [#5527](https://github.com/kamp-us/phoenix/issues/5527) (2026-08-13) that the
trigger-coverage obligation dies with the eval layer: no fabrika skill owes a trigger-coverage proof
on any surface, and 0249's premise is retired with its mechanism. So that clause names a measurement
nobody can read, and this entry restates the trigger without it.

## Decision

**At v1 retirement, delete both `.claude/skills` and `.claude/agents`, and keep the
`"kampus-pipeline@kampus": false` suppression in `.claude/settings.json`.**

The suppression is what keeps the retired roster off every machine. Deleting the symlinks removes
the in-repo copy; the suppression removes the other way back in. They are not a pair that must move
together — they are two independent doors, and retirement closes both.

Keeping the line costs nothing on a machine without the plugin: the CLI skips an `enabledPlugins`
entry that names a plugin it cannot find (ADR 0077's own consequence). It only does work on the
machine where someone installs `kampus-pipeline`, which is exactly the case worth guarding.

The suppression names `kampus-pipeline@kampus` and nothing else, so fabrika's own plugin is
untouched by it (ADR 0273).

### What this overrides in ADR 0255

0255 states one requirement in four grammatical forms. All four are overridden, and only in the
direction of the suppression — everything else in 0255 stands, including that the symlink is the
retirement lever and that `.claude/agents` retires on the same pull.

| Site in `0255-skill-namespaces-keep-v1-and-fabrika-apart.md` | 0255 says | now reads |
|---|---|---|
| §2, third bullet ("Why the loading path is not cut now") | dropping the symlink obliges removing the suppression in the same change, or the suite becomes unreachable in-repo | the symlink and the suppression are independent; at retirement the suite is *meant* to be unreachable in-repo, so a half-cutover concern no longer applies |
| §3, step 3 ("At retirement") | delete the symlink **and remove** the suppression in the same change | delete both symlinks and **keep** the suppression |
| `### Binding constraints`, fourth bullet | `.claude/skills` and `.claude/agents` retire together with the 0077 suppression removal, in one change | `.claude/skills` and `.claude/agents` retire together, in one change; the suppression stays |
| `### Banned`, second bullet | deleting the symlink without removing the suppression is banned | deleting the symlinks while keeping the suppression is the required act |

### The retirement trigger, restated

0255 §3 fires when **fabrika covers the pipeline**. The *"and its eval sets show its skills fire"*
half is dropped: per the #5527 ruling no skill owes trigger coverage, and ADR 0249's premise is
retired with its mechanism. Whoever holds the seat records that coverage is met; no eval-set reading
is owed, and none is possible.

**Binding constraints.**

- At v1 retirement, `.claude/skills` and `.claude/agents` are deleted in one change.
- `"kampus-pipeline@kampus": false` stays in `.claude/settings.json` through that change and after it.
- The retirement trigger is fabrika covering the pipeline, recorded by whoever holds the seat.

**Banned.**

- Removing the `kampus-pipeline@kampus` suppression as part of retiring v1.
- Citing ADR 0077's final consequence bullet, or any of ADR 0255's four sites above, as a live
  instruction to remove it.
- Reading the surviving suppression as evidence that the plugin is still a wanted in-repo source.

## Consequences

- Retirement stays one small change, and it now leaves v1 unreachable from both directions rather
  than one.
- `.claude/settings.json` keeps an entry for a plugin phoenix no longer ships. That reads as dead
  config to a cold reader, which is exactly why this entry exists to point at.
- ADR 0077's decision — suppress the plugin in-repo — is unchanged and still in force. Only its final
  consequence bullet is reversed.
- ADR 0255's decision — namespaces separate the two rosters, the symlink is the retirement lever — is
  unchanged. Only the suppression clause at its four sites is reversed, and its trigger loses the
  eval-set half.
- [#5276](https://github.com/kamp-us/phoenix/issues/5276)'s decision blocker is cleared. Its other
  flip conditions are untouched and still hold it parked.

## Records

- **Executed 2026-08-14** by [#5276](https://github.com/kamp-us/phoenix/issues/5276) (skills half)
  and [#5537](https://github.com/kamp-us/phoenix/issues/5537) (agents half), landed as one pull
  request after the founder ruled the split over: `.claude/skills` and `.claude/agents` are deleted,
  `.claude/.pipeline` stays (a literal path alias, ADR 0255 §5), and
  `"kampus-pipeline@kampus": false` stays in `.claude/settings.json` exactly as this entry decides.
  The same commit repoints the ten `- run:` steps in `ci.yml`'s `skills` job at
  `claude-plugins/kampus-pipeline/skills/…` and drops `validate-gate-path-drift.sh`'s
  symlink-is-a-symlink invariant, which had the deleted link as its subject.
- Closes [#5532](https://github.com/kamp-us/phoenix/issues/5532).
- Amends in part [0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md) and
  [0077](0077-in-repo-pipeline-skill-discovery-doubling.md); both status lines carry the link, both
  bodies are untouched.
- The #5527 ruling retires ADR [0249](0249-skill-trigger-coverage-lives-in-the-eval-set.md)'s
  premise. This entry only stops *citing* 0249's measurement; restating 0249's own status is a
  separate act and is not done here.
- No vocabulary impact. Nothing is coined or redefined — this re-decides one instruction over
  concepts 0077 and 0255 already named.
