---
id: 0417
title: A campaign groups work under a theme and never refuses a lane
status: accepted
date: 2026-09-27
tags: [fabrika, pipeline, roadmap, security]
---

# 0417 — A campaign groups work under a theme and never refuses a lane

**What this decides:** a `## Campaigns` row stops being the permission a lane needs to open. It
still groups work and pins a milestone, but no campaign state makes `build claim` or `build pick`
turn an issue away. The gate comes out only after drivers pick bets first.

## Context

ADR [0304](0304-campaign-active-is-the-dispatch-permission.md) made a campaign's `State` cell the
dispatch permission. An issue is admitted only when an `active` row pins its milestone. The check is
the scope axis in
[`packages/fabrika-cli/src/build/scope-admission.ts`](../packages/fabrika-cli/src/build/scope-admission.ts)
(`scopeAxisOf`), and a claim it refuses exits `20`. ADR
[0245](0245-campaign-scope-fence-binds-both-seams.md) makes that one check bind both `build pick`
and `build claim`.

Epic [#9850](https://github.com/kamp-us/phoenix/issues/9850) replaces that gate with a weekly
betting table. Its rulings R14.1 (campaigns become themes) and R10.3 (guide work with defaults and
flags, never by refusing it) come from
[#9821](https://github.com/kamp-us/phoenix/issues/9821). Taking out a guard needs an adversarial
review first. That review is on
[#9852, comment 5852627247](https://github.com/kamp-us/phoenix/issues/9852#issuecomment-5852627247).
Its verdict was "safe with conditions": remove the gate only after bets-first picking ships, and
accept losing the pause switch.

Founder ruling, 2026-09-26, recorded on
[#9852, comment 5852643522](https://github.com/kamp-us/phoenix/issues/9852#issuecomment-5852643522),
in answer to "remove the gate, but only after bets-first picking lands, and accept losing the pause
switch?", verbatim:

> yes, remove it after bets-first lands

This record is that ruling written down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). The ruling answers the removal, its
order, and the pause switch. Any other condition the review raised is recorded below as the
review's, not as a ruling.

## Decision

**A `## Campaigns` row groups work under a theme and a milestone, and no campaign state refuses a
lane.**

- **The scope axis goes.** `build claim` no longer exits `20` because an issue's milestone has no
  `active` row, and `build pick` no longer drops such issues from its pool. The audience, type and
  criteria axes and the `blocked_by` gate stay exactly as they are.
- **Bets-first picking lands first.** The scope axis comes out only once `build pick` offers the
  current iteration's `bet` rows ahead of other work. Both changes are one child,
  [#9857](https://github.com/kamp-us/phoenix/issues/9857), so the order holds inside one change.
- **The pause switch is given up.** `paused` stays a `State` value, and `roadmap-guard` I5 still
  checks it against the milestone. It now tells a reader a campaign is alive but not being worked,
  and it no longer stops anything.
- **The `## Campaigns` table keeps grouping and milestones.** Rows, states and the `campaign` verbs
  stay. Only the gate goes.

### What the scope axis protected, and what covers each now

The review lists four protections. Each is either replaced by a part of #9850's table or dropped.

| The gate stopped | Covered after removal by | Left uncovered |
|---|---|---|
| A lane opening on a milestone nobody declared | Drivers pick bets first (R2.1), and every un-bet lane shows under Outside the bets with its origin, kind and cost (R3.1) | A human hand-start still opens freely, by design (R2.1) |
| A `paused` campaign halting its lanes between rounds | Nothing. The ruling accepts this loss | No per-theme pause between tables |
| A new push, or runaway spend, starting with no campaign row | Over-size flag and stop at 2x (R11.1), the asks flag (R10.1), the unknown-decider flag (R22.1), the more-than-3-active-campaigns flag | No cap on total spend across many un-bet lanes: the 2x stop is per lane, and the tally is weekly and after the fact |
| A repair claim on a PR that names no issue, refused only while some campaign is `active` (`resolveAdmissionSubject` in [`build/target.ts`](../packages/fabrika-cli/src/build/target.ts)) | The same check on its own exit, `38` (`NO_SERVED_ISSUE` in [`build/codes.ts`](../packages/fabrika-cli/src/build/codes.ts)), moved out of the scope axis as the review asked. It now binds whatever the campaigns say, and `--override` still admits it | Nothing. The ruling does not answer this check, so this record keeps it rather than dropping it |

The review also found the gate was already soft. `--override` and the standing-lane labels got
past it, and one malformed `## Campaigns` row blocked every claim. The four refusals in lane logs
(#8824, #9540, #8556, and the milestone #58 exit `20`) were all friction, and none was clearly
protective.

### The author-key fold

#9850's Authority section folds `campaignAuthors` and `capClearAuthors` into the control-plane set
read from `.github/CODEOWNERS` (ADR [0330](0330-codeowners-is-the-cp-boundary.md)). That set is the
one R21.1 names for deciding bets. The review names two effects, recorded here so the build does
not rediscover them:

- **Who may act widens.** Today `capClearAuthors` is `@usirin`, `@notusirin` and `@cansirin`, and
  `campaignAuthors` is `@usirin`. The `@kamp-us/control-plane` team is usirin, cansirin, rasitds
  and notusirin. So rasitds gains clearing a repair round, and the three accounts beyond usirin
  gain declaring and flipping campaigns.
- **The list moves out of review.** Today the set is a reviewed line in `.fabrika.jsonc`, read at
  the PR's base ref. After the fold it is team membership, which an org admin edits with no pull
  request.

The live `write+` ACL check of ADR [0294](0294-config-narrows-the-acl-never-replaces-it.md) stays.
The named set only changes where it is read from, so it still narrows the ACL and never replaces it.
ADR [0393](0393-lane-clear-grants-both-repair-budgets.md) names the old place for `lane clear`, so
this record amends it in part too.

**Binding constraints.**

- Nothing reads a campaign's `State` cell to refuse, skip or park a lane.
- The scope axis does not come out before bets-first picking is in the same change or already
  landed.
- A campaign may be flagged, for example when more than 3 are active. It is never enforced.

## Consequences

**Real work stops being refused for its milestone.** The four refusals the review found each cost a
founder turn or a workaround, and none of them happens again.

**One pause lever is gone.** A theme's running lanes now stop at the next table's "keep, finish, or
drop?" call (R2.1). There is no one-cell switch between tables any more.

**Spend has no total cap between tables.** Each lane stops at 2x its size, but many small un-bet
lanes can still add up within a week. The weekly tally shows it after the fact.

**More people hold two privileges.** The fold adds rasitds to round-clearing and three accounts to
campaign authoring. That list is edited in org settings, not in a reviewed file.

## Records

Fixes [#9852](https://github.com/kamp-us/phoenix/issues/9852). The code change is
[#9857](https://github.com/kamp-us/phoenix/issues/9857).

- Supersedes ADR [0304](0304-campaign-active-is-the-dispatch-permission.md): its whole subject is
  the `State` cell as dispatch permission.
- Supersedes ADR [0245](0245-campaign-scope-fence-binds-both-seams.md): its subject is where the
  campaign-scope refusal binds, and there is no refusal left to bind.
- Amends in part ADR [0294](0294-config-narrows-the-acl-never-replaces-it.md): the named set that
  narrows the live ACL for campaign authoring and round-clearing comes from CODEOWNERS instead of
  `.fabrika.jsonc`. Its two-clause rule stands.
- Amends in part ADR [0393](0393-lane-clear-grants-both-repair-budgets.md): its "The ACL does not
  move" clause says the account posting a `lane clear` must be in `.fabrika.jsonc`'s
  `capClearAuthors` at the PR's base ref. After the fold that account must be in the CODEOWNERS
  control-plane set instead, and that set is not read at any base ref. The live `write+` check and
  the rest of 0393 stand.
- ADR [0398](0398-machine-local-config-layer.md) lists `capClearAuthors` and `campaignAuthors` among
  the keys a machine-local layer may never override. Its rule stands: once the keys leave
  `.fabrika.jsonc` there is nothing for a local layer to override.
- ADR [0330](0330-codeowners-is-the-cp-boundary.md) calls the two keys adjacent ACLs that do not
  bound the control-plane boundary. That was a description, not a rule. After the fold they read
  the same CODEOWNERS rows, and they still do not bound it.
- ADR [0354](0354-running-campaign-admits-p0-and-p1.md) is untouched. Its `running` marker narrows
  what triage homes on a milestone, and it refuses no lane.

Vocabulary impact: **campaign** is redefined from dispatch permission to theme, and **scope
admission** retires. The `.glossary/TERMS.md` rows for `campaign`, `paused campaign`,
`scope admission` and `campaign lifecycle` describe behaviour that stays live until #9857 lands, so
they change with #9857 rather than with this record.
