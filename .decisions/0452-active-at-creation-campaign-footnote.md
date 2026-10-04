---
id: 0452
title: A campaign row minted active at creation carries an authorizing footnote under the Campaigns table
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline, roadmap]
---

# 0452 — A campaign row minted active at creation carries an authorizing footnote under the Campaigns table

**What this decides:** when a campaign row is written `active` in the commit that creates it, a line
below the `## Campaigns` table in `ROADMAP.md` names the row and links the ruling that allowed it.

## Context

A newly added `## Campaigns` row is `paused`, and flipping it to `active` is a separate, explicit
act (founder ruling on
[#6289, comment 5337951312](https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337951312)).
A founder can override that default and have a row minted `active` in its creating commit. The first
one was the "Geçit product push" row (`#24`), authorized at
[#6417, comment 5347095221](https://github.com/kamp-us/phoenix/pull/6417#issuecomment-5347095221).

The citation for that override lived only in the pull request's `## Deviations` section. A pull
request body is not part of the tree, so after the merge a reader of `ROADMAP.md` saw a row that
skipped the default with nothing saying who allowed it.
[#6420](https://github.com/kamp-us/phoenix/issues/6420) put three options to the founder: an ADR
amendment listing each override, a footnote under the table, or a ruling that the pull request
record is enough.

Founder ruling, 2026-08-20 PT, recorded on
[#6420, comment 5363114737](https://github.com/kamp-us/phoenix/issues/6420#issuecomment-5363114737),
verbatim:

> #6420 Trace for an active-at-creation campaign: (b) footnote line under the Campaigns table

The same comment carries the reading the ruling was recorded with: each override gets a
`<campaign> — active at creation, authorized by <url>` line beneath the table, outside the parsed
three-column grammar. This record is that ruling written down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

The ruling predates ADR [0417](0417-campaigns-are-themes-not-dispatch-permission.md), which made a
campaign a theme: `active` no longer admits a lane and no state refuses one. The paused-default is
still pinned in `ROADMAP.md`, so minting a row `active` still skips an explicit act and the trace
still has something to record. What `active` grants changed; the override did not go away.

## Decision

**A `## Campaigns` row minted `active` in its creating commit carries one footnote line below the
table, `<campaign> — active at creation, authorized by <url>`.**

- **The line names the row and links the ruling.** `<campaign>` is the row's `Campaign` cell.
  `<url>` is the comment where the founder allowed the override.
- **It sits after the table's last row.** A blank line separates it from the table, and each
  footnote is its own paragraph.
- **It never begins with `|`.** `scanCampaigns` in
  [`packages/fabrika-cli/src/build/scope-admission.ts`](../packages/fabrika-cli/src/build/scope-admission.ts)
  reads every `|`-leading line of the section as a data row, so a footnote written as one would make
  the whole table malformed. A line that starts with anything else is skipped by that scan, ends the
  table for `parseSectionRows` in
  [`packages/fabrika-cli/src/guard/roadmap.ts`](../packages/fabrika-cli/src/guard/roadmap.ts), and
  stays below a row `appendRow` adds.
- **The grammar paragraph under the table states the convention**, beside the paused-default it is
  an exception to.

**Binding constraints.**

- A footnote carries no state and no milestone. The row's `State` cell is the only place a
  campaign's state is written.
- The `Campaign | Milestone | State` grammar gains no column and no reader parses a footnote.

## Consequences

**The override is readable in the tree.** A reader of `ROADMAP.md` can tell a founder-authorized
`active` row from one that skipped the default unnoticed, without finding the pull request.

**Nothing enforces it.** No guard checks that a row minted `active` has its footnote, or that a
footnote's URL resolves. The trace holds only as long as whoever writes the row writes the line.

**Two later rows have none.** `Production-ready kamp.us` (`#57`,
[#9544](https://github.com/kamp-us/phoenix/pull/9544)) and `Tuval on tea` (`#58`,
[#9797](https://github.com/kamp-us/phoenix/pull/9797)) were each minted `active` in their creating
commit after the ruling. This record adds the Geçit footnote only, because naming what authorized
the other two is not something the ruling settles.

## Records

Fixes [#6420](https://github.com/kamp-us/phoenix/issues/6420).

- ADR [0304](0304-campaign-active-is-the-dispatch-permission.md) is superseded by 0417 and is left
  untouched. The issue offered an amendment there as one home for this ruling; a new record is the
  other, and it avoids amending a superseded one.
- ADR [0417](0417-campaigns-are-themes-not-dispatch-permission.md) stands unchanged. Its rule that
  nothing reads a campaign's `State` cell to refuse a lane is unaffected, because a footnote is read
  by no verb.

No vocabulary impact: this record coins no term.
