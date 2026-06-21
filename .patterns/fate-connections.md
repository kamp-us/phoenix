# Connections & pagination

How lists paginate. The short answer: a list is `list(view, {orderBy})` in the data view, and at runtime resolves to a `ConnectionResult<Node>` — `{items: [{cursor, node}], pagination: {hasNext, hasPrevious, nextCursor?, previousCursor?}}`. There are no `Connection`/`Edge`/`PageInfo` types. Keyset pagination lives in the services; this doc covers the two ways a service page reaches the client.

## Two delivery paths

| Path | Used for | Who owns the cursor |
|---|---|---|
| **Custom `lists` resolver** | top-level lists (`terms`, `posts`) | the service — `ConnectionResult` built from its page |
| **Parent custom `queries` resolver** | nested relations inside a view (`Term.definitions`, `Post.comments`, `Profile.contributions`) | the service — `ConnectionResult` built inline on the parent row |

Both paths build the `ConnectionResult` from a service keyset method; the difference is only where the resolver lives (a `lists` entry vs. the parent `queries` resolver). phoenix's sources carry **no** `connection` handler — see the note below for why one is never reached.

## Root lists — custom `lists` resolver

Services return a page (`{rows, hasNextPage, endCursor, totalCount}` — e.g. `DefinitionConnectionPage`, `TermPage`). A `lists` resolver maps that onto `ConnectionResult`, so the service keeps full control of cursor encoding and the keyset SQL:

```ts
lists: {
  terms: {
    type: "Term",
    // inside the Fate.list handler — Effect.fn("terms")(function* ({args}) {
      const sozluk = yield* Sozluk;
      const page = yield* sozluk.listTermSummariesConnection({
        first: typeof args?.first === "number" ? args.first : 20,
        after: typeof args?.after === "string" ? args.after : undefined,
        sort: (args?.sort as ListSort) ?? "recent",
      });
      return {
        items: page.rows.map((row) => ({cursor: row.slug, node: row})),
        pagination: {
          hasNext: page.hasNextPage,
          hasPrevious: false,                 // services page forward only
          nextCursor: page.endCursor ?? undefined,
        },
      };
    }),
  },
},
```

The cursor is whatever the service uses as its keyset (a slug, an id, an encoded score+id tuple) — the client treats it as opaque. This is the path for `terms` and `posts`.

## Nested connections — delivered inline by the parent resolver

A connection field inside a view (`Term.definitions`, `Post.comments`, `Profile.contributions`) carries a `ConnectionResult` on the parent row. The DB keyset lives in the service; the **parent resolver invokes it inline** (see [ADR 0019](../.decisions/0019-connection-pagination-strategy.md)).

> **A nested relation is never auto-fetched through a source `connection` handler.** The serving walk only **re-shapes** whatever the parent row already carries on a list field — an `Array` or a pre-built `ConnectionResult` — and the cursor it uses for a connection node is the node's **`id`** (fate's default `getCursor`), not the view's `orderBy` field values. Why a source `connection` handler is unreachable (on the interpreter and on fate's own server alike) is pinned in [fate-effect-interpreter.md](./fate-effect-interpreter.md) "The connection plane".

The phoenix shape that gives a true DB keyset:

1. **The parent is a custom resolver** (`term(slug)` is a `queries` entry, not a source-masked byId root). A custom resolver returns shaped output directly with no source masking, so it owns the whole `Term` shape — including the `definitions` connection.
2. **The resolver builds `definitions` as a pre-built `ConnectionResult`** from a service keyset method (`Sozluk.listDefinitionsKeyset`), only when the selection includes `definitions` (`hasNestedSelection(select, "definitions")`). Nested connection args arrive scoped under the field path (`args.definitions.{first,after}`), matching fate's `getScopedArgs`.
3. **The cursor is the node `id`** (matching fate's default `getCursor`). The service resolves that id to its `(orderBy-fields…, id)` keyset tuple and fetches the rows that follow it, so a page is a bounded `WHERE … LIMIT` — no skips/dupes, no loading the whole list.
4. **One per-connection `Ordering` is the single home for the order** — `(score desc, createdAt asc, id asc)` for `Term.definitions`, with `id` as the explicit final tiebreaker. An `Ordering` (`worker/db/ordering.ts`) names each column once — its view-field name, its Drizzle column, and its direction — and both the view's `list(view, {orderBy: viewOrderBy(ORDERING)})` and the service keyset (`keysetKeys(ORDERING, …)` + `orderByColumns(ORDERING)`) derive from it, so the nominal view order and the real DB order can no longer drift (they used to be copied per connection and kept in lockstep by a docblock). The source itself carries no `orderBy` or `connection` executor (they were dead — fate never invokes them for a hand-built source — and were removed; see the ADR 0019 1.0.4 amendment). The pano post feed single-sources its (per-sort) ordering the same way through `src/lib/panoFeedSort.ts`, which is DB-free so the SPA shares it.

Always include `id` as the final `orderBy` key — it's the stable tiebreaker that makes the keyset deterministic.

## The cursor-resolution port — keep the decision pure, the DB read thin

A keyset method resolves the opaque `after` cursor to its keyset tuple, then **decides**: a cursor that resolves to no row is the shared *cursor-miss → empty-page* semantic; a resolved cursor builds the `keysetAfter(...)` predicate; an absent cursor pages from the head. Only the *read* of the cursor row needs a database — the **decision** (miss vs. hit vs. no-cursor) and the page-envelope shaping (`forwardPage`) are pure (ADR 0082: cursor resolution is a port, the keyset/cursor-miss decision is pure). So lift the decision above the `run((db) => …)` seam:

```ts
// the port — the only piece that needs a DB
const resolvedRow = after
  ? (yield* run((db) => db.select({…keyset cols…}).from(view).where(eq(view.id, after)).get())) ?? null
  : null;
// the pure decision (db/keyset.ts) — unit-testable with no SQL engine
const cursor = resolveCursor<CursorRow>(after, resolvedRow);
if (cursor.kind === "miss") return {...emptyKeysetPage, totalCount} satisfies …ConnectionPage;
const cursorRow = cursor.kind === "hit" ? cursor.row : null;

// the lead-column tuple derives from the same per-connection `Ordering` the
// view `orderBy` and `.orderBy(…)` use (db/ordering.ts), so they can't disagree
const cursorPredicate = keysetAfter(keysetKeys(ORDERING, (field) => /* cursorRow value */));
const fetched = yield* run((db) => db.select()….where(cursorPredicate ? and(base, cursorPredicate) : base).orderBy(...orderByColumns(ORDERING)).limit(first + 1));
const page = forwardPage(fetched, first, (r) => r.id, mapRow);   // pure envelope
return {...page, totalCount} satisfies …ConnectionPage;
```

`resolveCursor(after, resolvedRow)` returns a `CursorResolution<TRow>` (`no-cursor` | `miss` | `hit`), `emptyKeysetPage` is the canonical empty forward page, and `forwardPage` slices the `first + 1` probe into `{rows, hasNextPage, endCursor}`. All three live in [`apps/web/worker/db/keyset.ts`](../apps/web/worker/db/keyset.ts) and are covered by `keyset.unit.test.ts` with **no DB** — the DB read stays a thin port exercised only by the `integration` keyset verticals. The litmus (ADR 0082): "could this be wrong even if the DB behaved perfectly?" — the miss/envelope decision could, so it's pure/unit; the cursor read only-differs-if-the-DB-differs, so it stays integration. Search's FTS keyset (`Search.ts`) routes its bm25-rank cursor through the **same** `resolveCursor`/`forwardPage` pair (a `0` rank is a valid hit, not a miss).

## See also

- [fate-data-views.md](./fate-data-views.md) — `list(view, {orderBy})` in a view
- [fate-effect-sources.md](./fate-effect-sources.md) — the `byId`/`byIds` source loaders
- [fate-effect-operations.md](./fate-effect-operations.md) — `Fate.list` handlers returning `ConnectionResult`
- [fate-effect-interpreter.md](./fate-effect-interpreter.md) — the serving-path connection plane (windowing, scoping, what is deliberately not reimplemented)
- [ADR 0019](../.decisions/0019-connection-pagination-strategy.md) — connection pagination strategy
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/server.ts` (`commentSearch` custom list)
