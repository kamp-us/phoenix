# Page queries — one root query per page

> Derived from `@nkzw/fate@1.3.1` — re-verify on pin bump.

How a page or route composes its data into fate requests. The short answer, Relay-style: a
page issues **one root query** — a single `useRequest` whose view tree names everything the
screen needs, with nested connections composed **inline** into that root selection, not fetched
as separate requests. A page resolves its whole composed view in one round-trip; a second query
on a page is an exception that must justify itself.

This is the page-composition law over the read model in
[fate-views-and-requests.md](./fate-views-and-requests.md) (views, `useView`, `useListView`) and
the loading behaviour in [fate-async-react.md](./fate-async-react.md) (Suspense, transitions,
skeletons). Those docs cover the *mechanism*; this one covers **how many queries a page issues
and how the pieces compose**.

## The rule — one root query, nested connections inline

fate composes co-located views up the component tree to a single root, where the request is made:
*"Views are composed into a single request per screen, minimizing network requests and
eliminating waterfalls"* (fate reference, *View Composition* / *Fetching Data with `useRequest`*).
A page follows that to the letter:

- **One `useRequest` per page.** The screen root declares the whole view tree — header fields
  **and** every below-the-fold section — in one request item. `useRequest` batches it into one
  operation set, suspends until it resolves, and populates the cache; the nested `useView` /
  `useListView` calls then read from cache and fire **no further requests**.
- **Nested connections ride the root view, inline.** A section's paginated list is a nested
  connection field on the root entity's view (`{items: {node: RowView}}`), with its page size in
  the request args — never a second request key. The server resolver delivers that connection
  **inline** in the same resolver pass (gated on `hasNestedSelection`), so the header counts and
  the list arrive together in the single round-trip.

The exemplar is the public profile page. Its root `useRequest` selects the header view **spread
in** plus the `contributions` connection nested on the same `Profile` view — one request, one
round-trip:

```tsx
// apps/web/src/pages/UserProfilePage.tsx
const ContributionsConnectionView = {items: {node: ContributionView}} as const;

const UserProfileView = view<Profile>()({
	...UserProfileHeaderView,            // header fields spread in
	contributions: ContributionsConnectionView,  // the feed rides the same Profile view
});

function UserProfileContent({username}: {username: string}) {
	// ONE root query: header + first page of contributions in a single request.
	const {profile} = useRequest({
		profile: {view: UserProfileView, args: {username, contributions: {first: PAGE_SIZE}}},
	});
	// UserProfileHeader reads useView(UserProfileHeaderView, profile);
	// ContributionsList reads useListView(ContributionsConnectionView, profile.contributions).
}
```

The connection is delivered inline by the root resolver, not a separate list root:

```ts
// apps/web/worker/features/pasaport/queries.ts — the `profile` resolver
const base = toProfile(row);
if (!hasNestedSelection(select, "contributions")) return base;   // header-only selection: skip the keyset
const connection = yield* pasaport.listContributions({authorId: row.userId, sandboxViewer, ...});
return {...base, contributions};                                  // header + feed, one pass
```

The same shape backs every phoenix detail page: `Post.comments`
([`features/pano/queries.ts`](../apps/web/worker/features/pano/queries.ts)) and
`Term.definitions` ([`features/sozluk/queries.ts`](../apps/web/worker/features/sozluk/queries.ts))
are both nested connections delivered inline from their root query resolver, read on the client
off the root entity's `useView`. There is **no top-level `comments` / `definitions` / `contributions`
request key** — the connection is not addressable as its own root ([fate-views-and-requests.md](./fate-views-and-requests.md#requests--one-per-screen)).

## Why one root query, not many

| If you… | You get | Because |
|---|---|---|
| put the whole tree in one `useRequest` with nested connections | one round-trip, no waterfall, header + list arrive together | fate batches the composed view server-side; nested connections resolve in the same resolver pass |
| split a section into its own second `useRequest` | a request waterfall; the section can't paint until its own round-trip lands | the second request is gated on the first render, and nothing above-the-fold ungates it |
| try to address a nested connection as a top-level request key | a compile/runtime error | a `useRequest` key must be a client-**root** name; a nested connection is not a root ([fate-views-and-requests.md](./fate-views-and-requests.md#requests--one-per-screen)) |

The one-round-trip model is also **why above-the-fold content is never gated on the slowest
loader** — there is no separate slow loader to gate on. See
[fate-async-react.md](./fate-async-react.md) for how that interacts with Suspense and skeletons.

## A second query on a page needs explicit justification

Default to one. A page that issues a **second** fate request must name why the data can't ride
the root query. The one sanctioned exception today:

- **`useProfileStats` — a scalar stats read above the Suspense boundary.** `ProfilePage` renders
  directly under the `Layout` shell, **above** any `<Screen>` Suspense boundary, so it cannot
  suspend — it must drive fate imperatively rather than through the suspending `useRequest`.
  `useProfileStats` (`apps/web/src/pages/useProfileStats.ts`) issues an **imperative**
  (`useImperativeView`) read of the same `profile` root, selecting **only the count scalars** (no
  `contributions` connection, so the resolver skips its keyset), and returns a discriminated
  `idle | loading | ok | error` state. It is the exception because it sits structurally above the
  boundary the one-root-query model lives under — **not a pattern to copy** for a section that
  *can* sit inside the page's Suspense tree. A below-the-fold section inside the boundary rides
  the root query.

The filter: a second request is justified only when the data cannot be composed into the page's
root `useRequest` — e.g. it is read outside/above the page's Suspense boundary (the
`useProfileStats` case), or it is a genuinely independent root list the page shows alongside the
main entity (two `lists` roots read in **one** `useRequest`, still one request —
[fate-views-and-requests.md](./fate-views-and-requests.md#requests--one-per-screen)). "This
section is below the fold" is **not** a justification — that is what inline nested connections are
for.

## `defer` on a nested connection is blocked

fate ships `defer(selection)` — a field resolves under its own `<Suspense>` boundary while the
parent paints eagerly. It is the natural tool for "header first, slow section streams in." **It
does not work against a phoenix nested connection today and is blocked pending the
[#2188](https://github.com/kamp-us/phoenix/issues/2188) seam decision** — `readDeferred` resolves
a deferred handle by a **byId fetch of the owner entity**, but phoenix delivers nested connections
**only** from the root query resolver (the owner's byId source returns the base entity without the
connection), so the deferred handle never fulfils and the section hangs in its skeleton forever.

The full mechanism, grounding, and the exact `readDeferred` → `fetchById` seam are documented once
in [fate-async-react.md](./fate-async-react.md#why-defer-doesnt-apply-to-phoenixs-nested-connections-today) —
do not reach for `defer` on a nested connection; keep the connection eager on the root
`useRequest`.

## Live subscribes are post-paint — never gate first visibility on live

A live subscription must **never** gate the first visibility of a list. The page renders its list
from the **root query response**; the live subscription is additive on top of the
already-populated cache. `useLiveView` / `useLiveListView` are drop-in replacements for `useView` /
`useListView` that read the **same store** — switching to the live variant needs no other change
because the root query already populated the cache the live view reads from
([fate-live-views.md](./fate-live-views.md)). So:

- **Render from the root query, then subscribe.** The list is visible the moment the root
  `useRequest` resolves; the live variant only opts the already-rendered ref into server-pushed
  updates. A page that waited on a live round-trip before showing rows would show an empty screen
  until the first push — live is best-effort (no v1 replay), so that push may never come.
- **A live view does not change the query shape.** The view definitions passed to
  `useLiveListView` are the same `{items: {node: RowView}}` the root query selected. Live is a
  subscription layered over the one-root-query paint, not a second data source.

## Anti-patterns

- **A second `useRequest` for a below-the-fold section.** Splits the page into a waterfall. Nest
  the section's connection on the root view and read it with `useListView` off the root ref.
- **Fetching a nested connection as its own request key.** `Post.comments` / `Term.definitions` /
  `Profile.contributions` are **not** top-level roots; they ride the parent query's args
  (`args: {..., comments: {first}}`) and are read off the parent's `useView`
  ([fate-views-and-requests.md](./fate-views-and-requests.md#requests--one-per-screen)).
- **Copying `useProfileStats` for an in-boundary section.** It exists only because `ProfilePage`
  sits above the Suspense boundary. A section that *can* live inside the page's Suspense tree rides
  the root query; don't mint a second imperative read to fetch it.
- **`defer` on a nested connection.** Hangs the section forever against phoenix's data seam
  (blocked pending [#2188](https://github.com/kamp-us/phoenix/issues/2188)); keep it eager on the
  root request ([fate-async-react.md](./fate-async-react.md#why-defer-doesnt-apply-to-phoenixs-nested-connections-today)).
- **Gating list visibility on a live subscription.** The list must paint from the root query
  response; live is post-paint and best-effort.

## See also

- [fate-views-and-requests.md](./fate-views-and-requests.md) — the read model: `view`/`useView`/`useListView`, one batched request per screen, why a nested connection isn't a request key
- [fate-async-react.md](./fate-async-react.md) — the loading path over one root query (Suspense, transitions, height-matched skeletons); why `defer` doesn't reach nested connections
- [fate-connections.md](./fate-connections.md) — how the server resolves a nested connection inline from the root query resolver
- [fate-live-views.md](./fate-live-views.md) — `useLiveView`/`useLiveListView`, the read-from-the-same-store drop-in, the publish invariant
- [per-feature-fate-aggregators.md](./per-feature-fate-aggregators.md) — where a feature's `queries.ts` root resolvers live
- fate reference (in the [fate](https://github.com/usirin/fate) repo README): *View Composition*, *Fetching Data with `useRequest`*, *Deferred Views*
