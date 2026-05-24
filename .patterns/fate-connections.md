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

## Nested connections — delivered inline by the parent resolver (1.0.3)

A connection field inside a view (`Term.definitions`, `Post.comments`, `Profile.contributions`) carries a `ConnectionResult` on the parent row. The DB keyset still lives in the service; what differs from the original plan is **who invokes it**.

> **fate 1.0.3 drift — the native path does NOT auto-invoke a nested relation's `connection` executor (source authoritative; verified against `@nkzw/fate@1.0.3`).** `resolveSourceConnection` (the function that calls a source's `connection` handler) is reached from exactly two places in 1.0.3: the **root `list` operation** (`server.mjs`) and the **Drizzle adapter's** nested-relation resolver (`server/drizzle.mjs`). phoenix bans the Drizzle adapter (ADR 0016), so for a hand-built source resolver, fate's `resolveNode` only **re-shapes** whatever the parent row already carries on a `list()` field — an `Array` or a pre-built `ConnectionResult` — via `arrayToConnection`. It never fetches the nested relation through an executor, and the cursor it uses for a connection node is the node's **`id`** (the default `getCursor`), not the view's `orderBy` field values. So the originally-planned "fate owns the cursor, derived from the view `orderBy`" does not hold for nested fields in 1.0.3.

The phoenix shape that gives a true DB keyset and parity:

1. **The parent is a custom resolver** (`term(slug)` is a `queries` entry, not a source-masked byId root). A custom resolver returns shaped output directly with no source masking, so it owns the whole `Term` shape — including the `definitions` connection.
2. **The resolver builds `definitions` as a pre-built `ConnectionResult`** from a service keyset method (`Sozluk.listDefinitionsKeyset`), only when the selection includes `definitions` (`hasNestedSelection(select, "definitions")`). Nested connection args arrive scoped under the field path (`args.definitions.{first,after}`), matching fate's `getScopedArgs`.
3. **The cursor is the node `id`** (matching fate's default and the legacy GraphQL `cursor: row.id`). The service resolves that id to its `(orderBy-fields…, id)` keyset tuple and fetches the rows that follow it, so a page is a bounded `WHERE … LIMIT` — no skips/dupes, no loading the whole list.
4. **The view's `list(view, {orderBy})` still declares the order** — `(score desc, createdAt asc, id asc)` for `Term.definitions` — kept in lockstep with the service `ORDER BY`, with `id` as the explicit final tiebreaker. The `Definition` source's `orderBy` and a `connection` executor are still defined (they're the single keyset read the root-list path would use, and the inline resolver delegates to the same service method), so the order contract has one home.

Always include `id` as the final `orderBy` key — it's the stable tiebreaker that makes the keyset deterministic.

> If a future fate release auto-invokes nested `connection` executors for hand-built sources, the inline `ConnectionResult` build in the parent resolver can be dropped in favor of wiring the relation on the parent source; the service keyset method stays unchanged.

## See also

- [fate-data-views.md](./fate-data-views.md) — `list(view, {orderBy})` in a view
- [fate-sources.md](./fate-sources.md) — the `connection` source executor (root-list path)
- [fate-effect-bridge.md](./fate-effect-bridge.md) — `fateList` returning `ConnectionResult`
- void reference (in the [fate](https://github.com/usirin/fate) repo): `example/void/src/fate/server.ts` (`commentSearch` custom list)
- fate internals (verified in `node_modules/@nkzw/fate@1.0.3`): `resolveConnection`/`arrayToConnection`/`resolveSourceConnection` in `sourceRouter-*.mjs`; root-list call site in `server.mjs`
