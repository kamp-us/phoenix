# Views & requests

How components declare and read data. The short answer: each component declares a **view** — the fields it needs — co-located with it. Views compose up the tree; a screen root resolves the whole composed tree in **one** `useRequest`. Child components read their slice with `useView`. fate fetches everything in a single request, so there are no waterfalls and no loading states to coordinate.

This is the client mirror of the server's data views ([fate-data-views.md](./fate-data-views.md)) — same field-selection model, same masking.

## Views and `useView`

```tsx
// src/components/sozluk/DefinitionCard.tsx
import {view, useView, type ViewRef} from "react-fate";
import type {Definition} from "../../../worker/features/fate/views";  // server Entity<> type

export const DefinitionView = view<Definition>()({
  id: true,
  body: true,
  score: true,
  author: UserView,                 // compose another view
});

export const DefinitionCard = ({definition}: {definition: ViewRef<"Definition">}) => {
  const def = useView(DefinitionView, definition);
  return (
    <article>
      <p>{def.body}</p>
      <UserChip user={def.author} />  {/* def.author is a ViewRef<'User'> */}
    </article>
  );
};
```

- `view<T>()({...})` selects fields by setting them to `true` or to another view.
- `useView(View, ref)` resolves a `ViewRef` against the view and **subscribes to those fields** — the component re-renders only when a field it selected changes.
- A `null` ref returns `null` and does not subscribe.

## Masking — you see only what you selected

When a view embeds another **view** (`author: UserView`), the parent receives a `ViewRef<"User">` for that field, **not** the user's fields. To read the user you call `useView(UserView, def.author)` in the child. A component cannot read a field it didn't select — enforced at the type level and at runtime (the ref carries no data). This keeps components decoupled: adding a field to `UserView` never silently couples `DefinitionCard` to it.

> **Masking is by view *identity*, not field overlap.** A child's `useView(ChildView, ref)` only works if `ChildView` was **spread into the view the ref was built from**. A parent that merely re-lists the same *fields* (a different view object) makes `useView(ChildView, ref)` throw `"Invalid view reference. Expected the provided ref to include the view(s) '<ChildView>', received '<ParentView>'. … spread the correct view into its parent."` So compose **the same `Term` type's** child views by spreading: `view<Term>()({...TermHeaderView, definitions: {items: {node: DefinitionView}}})`. (A *related-entity* child like `author: UserView` is embedded as a field, not spread.) phoenix's `SozlukTermPage` spreads `TermHeaderView` into `TermView`; `SozlukTermHeader` then reads its slice with `useView(TermHeaderView, term)`.

## Requests — one per screen

A screen root declares every view its subtree needs and resolves them together:

```tsx
// src/pages/SozlukTermPage.tsx
import {useRequest} from "react-fate";

export const SozlukTermPage = ({slug}: {slug: string}) => {
  // `term` is a client query root; the definitions connection rides on the Term
  // view (nested), so the whole screen is ONE request item.
  const {term} = useRequest({
    term: {view: TermView, args: {slug, definitions: {first: 20}}},
  });
  return (
    <>
      <TermHeader term={term} />
      <DefinitionList term={term} />   {/* reads term.definitions via useListView */}
    </>
  );
};
```

> **A `useRequest` KEY must be a client-root NAME.** `RequestResult<R,Q>` maps `{[K in keyof Q]: K extends keyof R ? … : never}` — the key is looked up in the generated client `roots`, and the native transport sends the key verbatim as the operation `name`. So you can't *alias* a request key, and the vite plugin forces a `Root` entry's generated name to equal its server resolver name (`FateAPI['lists'][name]`). Consequences for phoenix:
> - **A screen that needs two filtered lists of the same type needs two list roots** (one resolver each). The sözlük home's recent + popular columns are two server `lists` resolvers (`recentTerms`/`popularTerms`, fixed-sort wrappers over the `terms` keyset) + two `Root` entries, read in one `useRequest({recentTerms, popularTerms})`.
> - **A detail page's nested connection is NOT a separate request key.** `Term.definitions` rides on the `term` query item (`args: {slug, definitions:{first}}`) and is read with `useListView(DefinitionConnectionView, term.definitions)` — there is no top-level `definitions` root.

Custom-resolver roots (`term`, `recentTerms`, …) are declared by the `Root` value in `worker/features/fate/views.ts` (the plugin emits them as typed client roots — see [fate-client-setup.md](./fate-client-setup.md)).

### A `key`-bump remount does NOT refetch a `network-only` `useRequest` — force a fresh read imperatively {#remount-no-refetch}

`useRequest(req, {mode: "network-only"})` fetches on **first mount**, but a `key`-bump remount of the same component reads the **already-fulfilled cached handle for the unchanged requestKey WITHOUT a network read**. So a screen that re-reads state by remounting (`<Content key={reloadKey} />`) silently gets the *stale* value, not a fresh one — `network-only` does not mean "always network" on the render path.

The cause is a **render-before-cleanup ordering seam**, not a quirk of `network-only`'s name. On a `key` bump React renders the new mount **before** running the old mount's effect cleanup: the new mount's render-path read (fate's `prepareRequestForRender` → `requestWithDescriptor(…, {revalidateExisting: false})`) reads the still-present fulfilled handle for that requestKey *before* the old mount's `useRequest` cleanup `releaseRequestKey(requestKey, "network-only")` runs. The render-path read passes `revalidateExisting: false`, which does **not** satisfy fate's re-execute guard for a fulfilled `network-only` handle, so the cached value is returned and no fetch fires. This is **intended** `react-fate` behavior, not a bug — it has a test enforcing *"does not refetch network-only inline requests during rerenders with the same key"*, which a same-key remount is indistinguishable from at the client layer (both present an identical fulfilled handle + `revalidateExisting: false`; only React cleanup ordering differs).

The corollary that bites: **phoenix cannot make the render/suspense path itself refetch on remount.** That lives inside fate's `prepareRequestForRender`; a phoenix-side wrapper hook can only bolt an imperative read alongside the suspending one — which *is* the remedy below, not a way to change the render path. (Making a `network-only` *mount* re-execute while a same-key *re-render* still reuses the cache is a `react-fate` `useRequest` change — decision-class, the personal-fork → local-patch path of [ADR 0038](../.decisions/0038-dependency-patches-local-only.md) — not something to attempt from `apps/web`.)

**The remedy:** when you need a guaranteed fresh read across a known state change, issue an **imperative** `fate.request(req, {mode: "network-only"})` **before** the remount, rather than relying on the remount's render-path read. The imperative `FateClient.request` passes `revalidateExisting: true`, which **re-executes** the fulfilled handle and repopulates the store; the subsequent remount then reads the real value:

```tsx
// the fresh-slug add-definition flow: definition.add auto-creates the term, so the
// next render must re-read term(slug). A bare `key` bump reuses the fulfilled
// `data: null` handle, so force a real network re-read FIRST, then remount.
await fate.request(
  {term: {view: TermView, args: {slug, definitions: {first: PAGE_SIZE}}}},
  {mode: "network-only"},
);
onTermCreated(createdId);   // bumps reloadKey → the remount now reads the real term
```

Live call sites:

- `apps/web/src/pages/SozlukTermPage.tsx` — the fresh-slug term re-read (#817): the composer force-refetches `term(slug)` imperatively, **then** bumps `reloadKey`. The inline comment at the `fate.request` call documents the exact seam.
- `apps/web/src/fate/useReadbackRefetch.ts` / `apps/web/src/pages/PanoPostDetail.tsx` — `network-only` driven imperatively (`fate.request`) from a confirmed state change, never via a remount. This is the sanctioned shape ([fate-live-views.md](./fate-live-views.md#read-back)).

**Recognizing it:** any flow that re-reads data by remounting a component (a `key`/`reloadKey` bump) after a write or navigation that changed server state, expecting the remount's `useRequest` to re-fetch. It won't — the symptom is the screen reading back the *pre-change* value (a cached `null`, a stale list) until a full reload. Drive the re-read with an imperative `fate.request(…, {mode: "network-only"})` before (or instead of) the remount.

Request item shapes:

| Item | Resolves to |
|---|---|
| `{view: V, args?}` | a single root entity (e.g. `viewer`, a term by slug) |
| `{list: ConnectionView, args?}` | a connection / paginated list |
| `{id, view: V}` | one entity by id |
| `{ids, view: V}` | many entities by id |

`useRequest` composes the whole tree into **one** batched operation set, suspends until it resolves, and populates the cache. The nested `useView`/`useListView` calls then read from cache and fire no further requests — **no waterfall**. Args ride on the item (or on the view object for connection page size).

## Lists & pagination — `useListView`

A `{list}` item resolves to a connection ref; a nested connection field (`term.definitions`) is read off the parent's `useView`. Either feeds `useListView`, which renders the page and loads more. The connection "view" is a plain `{items: {node: View}}` object (not a `view<T>()`):

```tsx
const TermView = view<Term>()({...TermHeaderView, definitions: {items: {node: DefinitionView}}});
// …
const term = useView(TermView, termRef);
const [items, loadNext] = useListView({items: {node: DefinitionView}}, term.definitions);

return (
  <>
    {items.map(({node}) => <DefinitionCard key={node.id} definition={node} />)}
    {loadNext && <button onClick={() => loadNext()}>daha fazla</button>}
  </>
);
```

- `useListView(ConnectionView, ref)` → `[items, loadNext, loadPrevious]`. `items` are `{cursor, node}` where each `node` is a stable `ViewRef`.
- `loadNext`/`loadPrevious` are `null` when there's no further page; otherwise they thread the cursor and merge the new page into the cache.
- **Connection identity** strips pagination args (`first`/`after`/…) but keeps filter args (e.g. `sort`, `host`), so a feed filtered by `sort: "hot"` and one by `sort: "new"` are distinct connections that paginate independently.
- For live lists, `useLiveListView` is the drop-in variant — [fate-live-views.md](./fate-live-views.md).

## Tree shape

A page is one `useRequest` returning refs, then nested components each `useView`/`useListView` on those refs:

```
SozlukTermPage         useRequest({term: {view: TermView, args:{slug, definitions:{first}}}})
  TermHeader           useView(TermHeaderView, term)         // TermHeaderView spread into TermView
  DefinitionList       useView(TermView, term) → useListView({items:{node:DefinitionView}}, term.definitions)
    DefinitionCard     useView(DefinitionView, node)
```

Every read hits the cache the root request populated.

## See also

- [fate-client-setup.md](./fate-client-setup.md) — the client + Suspense/error rails these reads depend on
- [fate-mutations-client.md](./fate-mutations-client.md) — writing data back
- [fate-live-views.md](./fate-live-views.md) — `useLiveView`/`useLiveListView`
- [fate-data-views.md](./fate-data-views.md) — the server views these mirror
- [fate-connections.md](./fate-connections.md) — how the server resolves the lists
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/pages/index.tsx`, `src/ui/PostCard.tsx`
