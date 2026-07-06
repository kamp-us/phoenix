# Async React with fate

How phoenix makes navigation and in-screen data swaps **feel instant** with React 19's
concurrent primitives on top of fate's Suspense-based data model. The short answer: reads
suspend, so a screen never hand-rolls a loading flag — instead it (1) sits under a **stable**
`<Suspense>` boundary, (2) marks any state change that re-suspends as a **transition** so the
current UI stays interactive instead of hard-swapping to a fallback, and (3) sizes every
Suspense fallback (skeleton) to its real payload so arrival swaps in with no layout jump. A
fourth fate lever — `defer` — is **not usable against phoenix's data seam today** and the
"why" is load-bearing enough to document; see [Why `defer` doesn't apply here](#why-defer-doesnt-apply-to-phoenixs-nested-connections-today).

This is the client-side companion to [fate-client-setup.md](./fate-client-setup.md) (the
`<Screen>` rails) and [fate-views-and-requests.md](./fate-views-and-requests.md) (the read model).
It codifies the "feels instant" defaults from #2161 so a new screen gets them by default and the
loading flash can't return.

## The model in one paragraph

fate's `useRequest`/`useView`/`useListView` **suspend** while data is in flight and **throw** a
`FateRequestError` on boundary-class failures — so every screen sits under a `<Suspense>` + error
boundary, paired in [`src/fate/Screen.tsx`](../apps/web/src/fate/Screen.tsx). There is no
imperative loading state to coordinate; React's concurrent renderer decides *when* to show the
fallback. Our job is to shape the tree so it shows the fallback **only** on a genuine cold load —
never on a navigation or a filter swap where a previous screen was already on-screen and could
stay interactive. That shaping is the two levers below (transitions, height-matched skeletons),
grounded in fate's own async model (its README: *"React Suspense manages loading states… This
eliminates the need for imperative loading logic"*). **fate's single batched request per screen
already removes waterfalls** — every screen's whole composed view resolves in one round-trip, so
above-the-fold content is never gated on a *separate* slow request; the only wait is the one cold
load, which the height-matched skeleton covers.

## Lever 1 — `startTransition` keeps the current screen interactive across a re-suspend

When a state change swaps the data a suspending component reads (a new connection, a new query),
that component re-suspends. If the change is made **urgently**, React must show the nearest
Suspense fallback — a hard swap to a skeleton, even though a fully-rendered screen was just there.
Wrapping the change in a **transition** (`useTransition` / `startTransition`) tells React the
update is non-urgent: it keeps the **previous committed content** of the surrounding Suspense
boundary on-screen and interactive, renders the new tree in the background, and swaps atomically
when it's ready — surfacing the in-flight swap as `isPending` for a subtle dimming cue.

Two things must both hold for this to work:

- **The Suspense boundary must be stable across the change.** React can only keep showing prior
  content at a boundary that *was already committed*. A boundary that mounts fresh for the new
  state (e.g. a route element that fully remounts) has no prior content to preserve, so it shows
  its fallback — that's the cold-load path, and it's correct there.
- **The state change must be inside the transition.** Only updates dispatched inside
  `startTransition` are deferred.

**Route navigation is already a transition.** react-router's `BrowserRouter` dispatches its
router-state update inside `React.startTransition` by default (verified in react-router 7.15's
`dist/…/chunk-*.js`: `setState` wraps `startTransition(() => setStateImpl(newState))` unless
`useTransitions === false`). So a `<Link>` / `navigate()` across routes is concurrent already —
the reason a cross-route jump can still flash is that the *route element itself* remounts, giving
the destination a brand-new inner Suspense boundary (lever 2 + 3 address the flash you can't
avoid; there is no prior content at a first-mounted boundary).

**In-screen swaps are where we add an explicit transition.** The canonical case is a filter/sort
chip that swaps the fate connection under a stable screen boundary:

```tsx
// apps/web/src/pages/PanoFeed.tsx — switching a sort chip swaps to a different
// `sort` connection, so FeedContent re-suspends. The <Screen> boundary is stable
// across the swap (only the sort prop changes), so a transition keeps the current
// feed committed + interactive instead of hard-swapping to PanoFeedSkeleton.
const [isPending, startTransition] = React.useTransition();
const setFilterId = React.useCallback(
	(id: string) => {
		startTransition(() => {
			setSearchParams((prev) => {
				const next = new URLSearchParams(prev);
				next.set(PANO_SORT_PARAM, panoSortFromFilterId(id));
				return next;
			});
		});
	},
	[setSearchParams],
);
// …the current rows stay mounted; dim + `aria-busy` them while `isPending`.
```

Surface the pending state accessibly: dim the live region and set `aria-busy` on it, so the swap
reads as "loading the next view," not a frozen screen. Use motion tokens for the dim transition
(`--motion-base` / `--ease-standard`), never a hardcoded duration.

> **Mutations get transitions for free.** fate's mutation actions run inside React Actions, so a
> submit that suspends does not need a hand-rolled `startTransition`. Reach for `useTransition`
> only for a **read** that re-suspends on a state change (the filter-swap shape above). fate's
> README notes the manual `useTransition` fallback for non-Action call sites; our mutation hooks
> (`useDraftSubmit`) already sit on Actions.

<a id="why-defer-doesnt-apply-to-phoenixs-nested-connections-today"></a>
## Why `defer` doesn't apply to phoenix's nested connections today

fate ships a `defer(selection)` primitive — the parent view resolves on its eager fields and hands
back a `Deferred<T>` handle, and the component reading that handle owns a *separate* `<Suspense>`
boundary (fate README, *Deferred Views*). It is the natural tool for "header first, slow section
under its own boundary." **It does not work against phoenix's data seam, and shipping it stalls
the deferred section forever — do not reach for it on a nested connection.** This is grounded in
fate's client source, not intuition (the regression was caught by the deployed e2e, invisible to
jsdom unit tests — #2161, PR #2181):

- **How fate resolves a deferred handle.** `FateClient.readDeferred` (in `@nkzw/fate`'s
  `lib/index.mjs`) resolves a `Deferred` by calling `fetchByIdAndNormalize(ownerType, [ownerId],
  deferredPaths)`, which issues **`transport.fetchById(type, ids, select)`** — a **byId (`node`)
  fetch of the owner entity** requesting the deferred field. So `defer(Profile.contributions)`
  resolves by fetching `Profile` **by id** selecting `contributions`.
- **Why phoenix can't satisfy that fetch.** In phoenix every nested connection
  (`Profile.contributions`, `Post.comments`, `Term.definitions`) is **delivered inline by a custom
  root query resolver**, gated on `hasNestedSelection(select, "<field>")`
  (`worker/features/*/queries.ts`). The entity's **byId source** (`Fate.source(…, {byId})`)
  deliberately returns only the base entity — the sources even comment that the connection is
  *"delivered inline by `queries.profile`"* and *"custom executor for a hand-built source, so
  deliver `comments` inline."* So the byId fetch `readDeferred` issues returns the `Profile`
  **without** `contributions`; `missingForSelection` stays > 0; the handle never fulfils; the
  `<Suspense>` boundary hangs on its skeleton. The header (eager, byId-deliverable) paints; the
  deferred section is **lost, not deferred**.

The rule: **`defer` is only usable where the deferred field is deliverable by the owner's byId
source.** phoenix's nested connections are root-resolver-only, so `defer` is off the table for
them until (and unless) the byId sources are taught to deliver the connection — a fate/worker-seam
change, not an `apps/web` one.

**What satisfies AC2's intent instead — and why it's already met.** The goal is "above-the-fold
content isn't gated on the slowest loader." phoenix meets it structurally: **one batched request
per screen resolves the whole composed view server-side in a single round-trip** (header counts +
the contribution feed are built in the *same* `queries.profile` resolver pass), so there is **no
separate slow loader** for the header to wait on — the header and the list arrive together, and
the single cold-load wait is covered by the height-matched skeleton (lever below). Keep nested
connections **eager** on the screen's `useRequest`; do not wrap them in `defer`.

## Lever 2 — height-matched skeletons so arrival swaps in without a jump

A Suspense fallback must reserve the **same height** its real payload will occupy, or the page
reflows when content lands — the footer jumps, layout thrashes (CLS). A skeleton that renders a
handful of rows under a page that resolves to twenty jumps ~941px on arrival (#2161). Two rules:

- **Mirror the real DOM shape.** Compose the fallback from the shared `Skeleton` atom
  (`components/ui/atoms.tsx`) using the *same* container classes and row structure as the loaded
  view (`PanoFeedSkeleton` reuses `.kp-pano-list` / `.kp-pano-post`), so widths, gaps, and grid
  match without duplicating measurements.
- **Single-source the row count from the page size.** The feed skeleton's row count is
  `PANO_FEED_PAGE_SIZE` — the *same* constant the feed request's `first:` reads
  (`apps/web/src/lib/panoNav.ts`) — so the skeleton reserves exactly one row per arriving post and
  the two can never drift back apart (make-invalid-states-unrepresentable). A detail screen's
  skeleton (`SozlukTermSkeleton`, `PanoPostSkeleton`) mirrors its header + a representative page of
  rows the same way.

Skeletons use **real tokens** — spacing (`--s-*`), motion, sizing — never raw px/hex, and every
fallback is a labeled status region (`role="status"` + `aria-busy="true"` + a Turkish
`aria-label`, e.g. `yükleniyor…`) so assistive tech announces the load.

## Where each lever lives

| Lever | Primitive | Live site |
|---|---|---|
| Stable Suspense + error rails | `<Screen>` (Suspense + boundary) | every screen; [`src/fate/Screen.tsx`](../apps/web/src/fate/Screen.tsx) |
| Keep current UI across a re-suspend | `useTransition` + `isPending` dim | `PanoFeed` sort-chip swap |
| Above-the-fold ungating | one batched request (no waterfall) — **not** `defer` on nested connections ([why](#why-defer-doesnt-apply-to-phoenixs-nested-connections-today)) | every screen resolves its composed view in one round-trip |
| No-jump arrival | height-matched `Skeleton` fallbacks | `PanoFeedSkeleton`, `SozlukTermSkeleton`, `PanoPostSkeleton` |

## See also

- [fate-client-setup.md](./fate-client-setup.md) — `<Screen>` (Suspense + error boundary), the provider
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `view`/`useView`/`useListView`, one request per screen
- [fate-connections.md](./fate-connections.md) — how the server resolves nested connections inline (the reason `defer` can't reach them by id)
- [fate-mutations-client.md](./fate-mutations-client.md) — writes ride React Actions (no manual transition needed)
- [base-ui-accessibility.md](./base-ui-accessibility.md) — the accessible-name rules a status region follows
- fate reference (in the [fate](https://github.com/usirin/fate) repo README): *Data Fetching* (Suspense); *Deferred Views* (`defer` — see the phoenix-seam caveat above)
