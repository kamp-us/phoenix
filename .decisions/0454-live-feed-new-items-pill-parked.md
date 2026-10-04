---
id: 0454
title: Live feeds get a reveal-through-read-path "yeni girdiler" pill, parked until traffic justifies it
status: accepted
date: 2026-10-04
tags: [pano, live, ux, product]
---

# 0454 — Live feeds get a reveal-through-read-path "yeni girdiler" pill, parked until traffic justifies it

**What this decides:** live feeds will show new arrivals behind a "yeni girdiler" pill the reader
clicks to reveal, and nobody builds that pill until traffic makes it worth building.

## Context

A row that arrives over `/fate/live` inserts straight into an open feed today. There is no divider,
pill or count. [`apps/web/src/pages/PanoFeed.tsx`](../apps/web/src/pages/PanoFeed.tsx) renders the
pano feed list and
[`apps/web/src/fate/useImperativeView.ts`](../apps/web/src/fate/useImperativeView.ts) is the
live-view read plumbing. The only unread affordance in the product is the bildirim bell badge
([#2613](https://github.com/kamp-us/phoenix/issues/2613)).
[#6470](https://github.com/kamp-us/phoenix/issues/6470) filed that observation and names two costs.

1. **The feed shifts under a mid-scroll reader** when someone posts.
2. **Every viewer-derived field on a live row needs its own refetch workaround.** Viewer-derived
   data must not ride broadcasts ([#4313](https://github.com/kamp-us/phoenix/issues/4313)). The
   ruling on [#6462](https://github.com/kamp-us/phoenix/issues/6462), recorded in its
   [comment 5348831154](https://github.com/kamp-us/phoenix/issues/6462#issuecomment-5348831154),
   met that for the çaylak marker with a viewer-blind broadcast plus a client refetch through the
   read path. That is one field's special case. The next viewer-derived field needs another.

A pill whose click fetches the pending rows through the normal read path addresses both costs. The
list stops moving on its own, and the refetch becomes how every live arrival reaches the reader
instead of a workaround written per field.

#6470 left three questions for the founder: whether the affordance is worth doing at current
traffic, whether the reveal-through-read-path pill is the shape or a lighter divider or count is,
and when to build it.

Founder ruling, 2026-08-20, recorded on
[#6470, comment 5363124473](https://github.com/kamp-us/phoenix/issues/6470#issuecomment-5363124473),
as the issue quotes it:

> #6470 New-items pill on live feeds: Yes, but later — record the shape, park it

This record is that ruling written down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). Its source is #6470.

## Decision

**Live feeds get a new-items arrival affordance, its shape is a reveal-through-read-path pill
labelled "yeni girdiler", and the build is parked.**

- **The affordance is wanted.** A live feed tells its reader that new rows arrived.
- **The shape is the pill.** Live arrivals buffer behind a "yeni girdiler" pill and do not insert
  into the open list. A click on the pill reveals them, and the reveal fetches the pending rows
  through the normal read path. A lighter divider or count is not the shape.
- **The build is parked.** It is not built at current traffic. It is revisited when traffic
  justifies it. No feed-UI build leaves #6470 today, and this record changes no product code.

The ruling sets no traffic threshold and names no revisit date. Picking either is a later call for
the founder, and so is the pill's visual design.

**Binding constraints.**

- The label is the Turkish product copy `yeni girdiler`, lowercase.
- When the pill is built, its reveal goes through the normal read path. It does not render row
  payloads carried on the broadcast.
- Until it is built, a viewer-derived field on a live row keeps the #6462 arrangement: viewer-blind
  broadcast, client refetch through the read path.

## Consequences

**The shape is settled, so the later build starts from a recorded choice.** Whoever picks it up
does not reopen pill versus divider versus count.

**Both costs stay until then.** A feed still shifts under a mid-scroll reader, and each new
viewer-derived field on a live row still needs its own refetch workaround.

**Live delivery itself is not parked.** Rows keep arriving over `/fate/live` as they do today, so
ADR [0157](0157-realtime-is-a-core-ux-tenet.md) is untouched. What waits is the arrival affordance
on top of that delivery.

## Records

- Source: [#6470](https://github.com/kamp-us/phoenix/issues/6470) and its ruling comment.
- Related: [#6462](https://github.com/kamp-us/phoenix/issues/6462) and its ruling comment,
  [#4313](https://github.com/kamp-us/phoenix/issues/4313),
  [#2613](https://github.com/kamp-us/phoenix/issues/2613).
- No vocabulary impact: `yeni girdiler` is product copy for a surface that is not built, and no
  term is coined or redefined.
