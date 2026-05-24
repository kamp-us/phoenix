# Connections & pagination

How lists paginate. The short answer: a list is `list(view, {orderBy})` in the data view, and at runtime resolves to a `ConnectionResult<Node>` — `{items: [{cursor, node}], pagination: {hasNext, hasPrevious, nextCursor?, previousCursor?}}`. There are no `Connection`/`Edge`/`PageInfo` types. Keyset pagination lives in the services; this doc covers the two ways a service page reaches the client.

## Two delivery paths

| Path | Used for | Who owns the cursor |
|---|---|---|
| **Custom `lists` resolver** | top-level lists (`terms`, `posts`) | the service — `ConnectionResult` built from its page |
| **Source `connection` executor** | nested relations inside a view (`Term.definitions`, `Post.comments`) | fate — keyset cursors from the view's `orderBy` |

Pick the path by where the list lives: a root list is a `lists` resolver; a list field inside a view is a source `connection` handler.

## Root lists — custom `lists` resolver

Services return a page (`{rows, hasNextPage, endCursor, totalCount}` — e.g. `DefinitionConnectionPage`, `TermPage`). A `lists` resolver maps that onto `ConnectionResult`, so the service keeps full control of cursor encoding and the keyset SQL:

```ts
lists: {
  terms: {
    type: "Term",
    resolve: fateList(function* ({args}) {
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
          hasPrevious: false,                 // services page forward
          nextCursor: page.endCursor ?? undefined,
        },
      };
    }),
  },
},
```

The cursor is whatever the service uses as its keyset (a slug, an id, an encoded score+id tuple) — the client treats it as opaque. This is the path for `terms` and `posts`.

## Nested connections — source `connection` executor

A connection field inside a view (`Term.definitions`, `Post.comments`, `Profile.contributions`) resolves through that relation's source `connection` handler. fate owns the cursor here: it encodes the view's `orderBy` field values and over-fetches `take + 1` to compute `hasNext`. Two rules make this round-trip correctly:

1. **The view's `orderBy` matches the service's `ORDER BY` exactly.** `list(definitionDataView, {orderBy: {score: "desc", id: "asc"}})` ⇒ the service's definition page orders by `(score desc, id asc)`. A mismatch skips or duplicates rows across pages.
2. **The service's connection method pages by that keyset.** The `connection` executor receives `{cursor, direction, take, skip}`; it passes the decoded keyset to the service, which returns up to `take` rows after it. fate slices and re-encodes the cursors.

Always include `id` as the final `orderBy` key — it's the stable tiebreaker that makes cursors deterministic. fate appends `id asc` if absent; make it explicit so the service's `ORDER BY` and the view agree.

## See also

- [fate-data-views.md](./fate-data-views.md) — `list(view, {orderBy})` in a view
- [fate-sources.md](./fate-sources.md) — the `connection` source executor
- [fate-effect-bridge.md](./fate-effect-bridge.md) — `fateList` returning `ConnectionResult`
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/server.ts` (`commentSearch` custom list)
- fate cursor internals (in the [fate](https://github.com/usirin/fate) repo): `packages/fate/src/server/source.ts` (`encodeCursor`/`createKeysetSteps`), `connection.ts` (`resolveConnection`)
