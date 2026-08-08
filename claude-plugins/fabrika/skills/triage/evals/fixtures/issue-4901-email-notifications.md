# Issue #4901 — `status:needs-triage`, open

**Title:** Öneri: bildirimler tarayıcı push'u ile de gelsin, sekme kapalıyken de ulaşsın

**Author:** usirin

**Body:**

## Summary
This is a proposal, not a defect report. Bildirim already works inside the product — I'd like the
same moments to be able to reach someone whose tab is closed, through browser push. Nothing is
broken today; I am asking for a new delivery channel.

## What I was doing
Scoping how far the notification loop reaches today before proposing anything on top of it.

## What I observed
`apps/web/worker/features/bildirim/` is a live feature — `kind.ts` carries seven notification kinds
(`divan-vote`, `kefil`, `terfi`, `reply`, `vote`, `report-filed`, `caylak-pending`) and `channel.ts`
fans the per-recipient unread signal out over a live fate channel. That channel only reaches an open
tab. A browser-push path is not in the repo at all:
`grep -rniE "web-push|webpush|PushSubscription|pushManager|VAPID|serviceWorker" apps/web/src apps/web/worker packages infra`
returns nothing, `find apps/web -iname '*service-worker*' -o -iname 'sw.ts'` (excluding `dist/` and
`node_modules/`) finds no file, and there is no push-subscription table in
`apps/web/worker/db/drizzle/schema.ts`.

I also checked whether the channel question was already settled. The epic that built the in-product
loop (#1666, closed) drew its v1 scope line at in-app only — "email digest later; no push in v1" —
so push was named as outside that epic's scope rather than declined on its merits. Beyond that scope
line there is nothing: no ADR under `.decisions/` mentions browser push, and no open issue tracks a
push or digest channel.

## Why it matters
Somebody writes an entry, gets a reply an hour later, and never comes back to the tab that would
have shown it. The in-product signal only closes the loop for people who are already looking.

## Pointers
- `apps/web/worker/features/bildirim/`
- `apps/web/worker/db/drizzle/schema.ts`

## Suggested next step (non-binding)
No design attached on purpose — I don't know what push costs on workerd, or where a subscription
would live. I'm proposing the capability, not the shape.

<sub>Filed by an agent · session 9c21 · claude-opus-5</sub>
