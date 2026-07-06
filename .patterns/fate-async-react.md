# Async React with fate

How phoenix makes navigation and in-screen data swaps **feel instant** with React 19's
concurrent primitives on top of fate's Suspense-based data model. The short answer: reads
suspend, so a screen never hand-rolls a loading flag — instead it (1) sits under a **stable**
`<Suspense>` boundary, (2) marks any state change that re-suspends as a **transition** so the
current UI stays interactive instead of hard-swapping to a fallback, (3) `defer`s below-the-fold
sections so above-the-fold content isn't gated on the slowest loader, and (4) sizes every
Suspense fallback (skeleton) to its real payload so arrival swaps in with no layout jump.

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
stay interactive. That shaping is the three levers below (transitions, defer, height-matched
skeletons), grounded in fate's own async model (its README: *"React Suspense manages loading
states… This eliminates the need for imperative loading logic"*, and the `defer` / Deferred Views
section).

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

## Lever 2 — `defer` so above-the-fold content isn't gated on the slowest loader

By default a screen's one `useRequest` resolves the **whole** composed view before anything
paints — the header waits on the heaviest nested list. `defer(selection)` marks a field so the
parent view resolves as soon as the **eager** fields are ready, handing back a `Deferred<T>`
handle for the deferred field. The component that reads that handle (with `useView` /
`useListView` / `useLiveListView`) decides which `<Suspense>` boundary owns *its* loading state —
so the fast, above-the-fold content paints immediately while the slow section loads under its own
skeleton (fate README, *Deferred Views*: *"the parent view receives a deferred handle immediately
after the eager fields are available, and the component that reads that handle … decides which
Suspense boundary handles the loading state"*).

```tsx
// apps/web/src/pages/UserProfilePage.tsx — the header (name/tier/karma, from eager
// aggregate counts) paints at once; the below-the-fold contributions connection loads
// under its OWN <Suspense> boundary instead of gating the whole profile.
import {defer, useListView, view} from "react-fate";

const UserProfileView = view<Profile>()({
	...UserProfileHeaderView,                       // eager — above the fold
	contributions: defer(ContributionsConnectionView), // deferred — below the fold
});

function UserProfileContent(/* … */) {
	const {profile} = useRequest({profile: {view: UserProfileView, args: {/* … */}}});
	return (
		<>
			<UserProfileHeader profile={profile} />           {/* paints on eager resolve */}
			<Suspense fallback={<ContributionsSkeleton />}>   {/* the deferred field's own boundary */}
				<ContributionsList profile={profile} />
			</Suspense>
		</>
	);
}
```

Deferred fields are **explicit handles, not optional data**: if the deferred selection is missing
from the normalized cache, fate fetches *only* that selection and suspends *only* the component
that read it. Reach for `defer` when a screen has a clear above/below-the-fold split where the
below-the-fold section is genuinely secondary (a profile's contribution feed, a post's comment
thread). Don't defer the primary content a user came to see.

> **Nullable relations + `defer` — narrow the handle at the read site.** A server view field
> typed optional (`{contributions?: Contribution[]}`) makes `defer` brand the handle with a
> `| undefined` payload (`Deferred<ConnectionValue | undefined>`), which `useListView`'s deferred
> arm — wanting `Deferred<ConnectionValue>` — rejects. The handle is never actually `undefined`
> at read time (fate fetches the selection before the reader resolves), so narrow the branded
> payload at the single read boundary with a documented type helper
> (`type NonNullableDeferred<D> = D extends Deferred<infer V> ? Deferred<NonNullable<V>> : D`),
> not a server-view change. `useListView` still yields `[]` for a genuinely empty connection, so
> the empty-state branch is untouched. Live example: `ContributionsList` in `UserProfilePage.tsx`.

## Lever 3 — height-matched skeletons so arrival swaps in without a jump

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
  the two can never drift back apart (make-invalid-states-unrepresentable). A deferred section's
  skeleton reserves a representative page (`ContributionsSkeleton`).

Skeletons use **real tokens** — spacing (`--s-*`), motion, sizing — never raw px/hex, and every
fallback is a labeled status region (`role="status"` + `aria-busy="true"` + a Turkish
`aria-label`, e.g. `yükleniyor…`) so assistive tech announces the load.

## Where each lever lives

| Lever | Primitive | Live site |
|---|---|---|
| Stable Suspense + error rails | `<Screen>` (Suspense + boundary) | every screen; [`src/fate/Screen.tsx`](../apps/web/src/fate/Screen.tsx) |
| Keep current UI across a re-suspend | `useTransition` + `isPending` dim | `PanoFeed` sort-chip swap |
| Above-the-fold ungating | `defer` + a nested `<Suspense>` | `UserProfilePage` contributions |
| No-jump arrival | height-matched `Skeleton` fallbacks | `PanoFeedSkeleton`, `SozlukTermSkeleton`, `PanoPostSkeleton`, `ContributionsSkeleton` |

## See also

- [fate-client-setup.md](./fate-client-setup.md) — `<Screen>` (Suspense + error boundary), the provider
- [fate-views-and-requests.md](./fate-views-and-requests.md) — `view`/`useView`/`useListView`, one request per screen
- [fate-mutations-client.md](./fate-mutations-client.md) — writes ride React Actions (no manual transition needed)
- [base-ui-accessibility.md](./base-ui-accessibility.md) — the accessible-name rules a status region follows
- fate reference (in the [fate](https://github.com/usirin/fate) repo README): *Data Fetching* (Suspense), *Deferred Views* (`defer`)
