# Custom fate data sources

> **Obsolete (2026-05-16):** See [ADR 0009](../.decisions/0009-d1-direct-defer-dos-and-workflows.md). The d1-direct refactor removed `SozlukTerm`, `PanoPost`, and `Pasaport` DOs. Phoenix no longer needs a custom DO-backed fate source — Drizzle reads D1 for everything, and fate is not in use in the current shape. The custom-source contract notes below remain accurate against `@nkzw/fate` itself, so this file is kept as background reference for any future non-Drizzle source (HTTP API, R2, KV), but the Phoenix-specific framing (`*Detail` backed by DOs, `myVote` from DO sqlite, etc.) does not match the current codebase. Do not follow the DO-coupled guidance.

How to write a data source that isn't Drizzle or Prisma — for fate v1 alpha
(`@nkzw/fate` as of 2026-05-15, reading `packages/fate/src/server/`).

Phoenix needs this for **`*Detail` types backed by Durable Objects**
(`SozlukTerm`, `PanoPost`, `Pasaport`). Drizzle reads the D1 `*Summary`
projections; the DOs hold authoritative state and computed reads like
`myVote`. Same pattern works for HTTP APIs, KV, R2, or anything else that
fits an async `byId / byIds / connection` shape.

## What "source" means in fate

Three concepts, separated:

| Concept | What it is | Where |
|---|---|---|
| `DataView` | The shape a client can request (`dataView<Row>('User')({ id: true, name: true })`) | shared between client + server |
| `SourceDefinition` | Pairs a view with `{ id, orderBy?, relations? }` so fate can build query plans | server only |
| `SourceExecutor` | The async functions that actually fetch rows: `{ byId?, byIds?, connection? }` | server only |
| `SourceRegistry` | `Map<SourceDefinition, SourceExecutor>` — fate looks up the executor for a plan | server only |
| `SourceResolver` | `{ getSource, registry }` — what `createFateServer({ sources })` accepts | server only |

A "custom source" means: writing your own `SourceExecutor` (and either
your own `SourceResolver` or a composed one) instead of letting
`createDrizzleSourceAdapter` generate them.

The contract is tiny. The Drizzle adapter is one big implementation of
exactly the same surface — there is no privileged path.

## The minimum viable source

```ts
import {
  createSourceDefinition,
  createSourceRegistry,
  dataView,
  type Entity,
  type SourceExecutor,
} from '@nkzw/fate/server';

// 1. The shape the client can request.
type TermDetailRow = {
  slug: string;
  title: string;
  definitionCount: number;
};

export const termDetailView = dataView<TermDetailRow>('TermDetail')({
  slug: true,
  title: true,
  definitionCount: true,
});

export type TermDetail = Entity<typeof termDetailView, 'TermDetail'>;

// 2. The source definition — `id` is the field fate uses for keying + cursor.
//    For TermDetail the natural key is `slug`, not `id`.
export const termDetailSource = createSourceDefinition(termDetailView, {
  id: 'slug',
});

// 3. The executor — three optional handlers.
const termDetailExecutor: SourceExecutor<AppContext, TermDetailRow> = {
  byId: async ({ ctx, id, plan }) => {
    const stub = ctx.env.SOZLUK_TERM.get(ctx.env.SOZLUK_TERM.idFromName(id));
    return stub.getDetail({
      viewerId: ctx.sessionUser?.id,
      // Only fetch what was selected. plan.root.selectedFields is a Set<string>.
      fields: [...plan.root.selectedFields],
    });
  },
  // byIds + connection optional — omit if not supported.
};

// 4. Registry maps definitions → executors.
export const termDetailRegistry = createSourceRegistry<AppContext>([
  [termDetailSource, termDetailExecutor],
]);
```

That's a working source. `createFateServer` accepts anything matching
`{ getSource, registry }`, so you can wrap it:

```ts
import { createFateServer } from '@nkzw/fate/server';

export const fate = createFateServer<AppContext>({
  roots: { term: termDetailSource },
  sources: {
    getSource: (target) => {
      // Accept either a view or an already-resolved source definition.
      if ('view' in target && 'id' in target) return target;
      if (target === termDetailView) return termDetailSource;
      throw new Error(`Unknown source: ${target.typeName}`);
    },
    registry: termDetailRegistry,
  },
});
```

## What `plan` gives you

`SourceExecutor` handlers receive a `SourcePlan` — read these fields on
`plan.root`:

- `selectedFields: Set<string>` — top-level scalar fields the client asked
  for. Use this to drive `SELECT` / DO method input.
- `orderBy: SourceOrder` — `[{ field, direction }]`, already includes the
  `id` tiebreaker. Use for cursor pagination.
- `args: Record<string, unknown>` — request args (`first`, `after`,
  custom filters).
- `computeds: Map<string, ComputedFieldPlan>` — fate-managed computed
  fields. Most custom sources don't need these (DOs compute their own).
- `relations: Map<string, SourcePlanNode>` — nested data the client asked
  for. Custom sources usually return the relation inline (one DO call
  returns the whole detail) rather than hydrating relations separately.

Call `plan.resolve(item)` (or `plan.resolveMany`) at the end **only if you
go through `resolveSourceById` / `resolveSourceConnection`** — those
helpers call it for you. If you wire the executor directly into a
custom resolver, you call `plan.resolve` yourself.

In practice: use the `resolveSource*` helpers. They do the masking,
optimistic-update settling, and `ViewRef` minting that fate expects.

## Connection (paginated list) executor

```ts
import {
  encodeCursor,
  decodeCursor,
  type SourceExecutor,
} from '@nkzw/fate/server';

const termSearchExecutor: SourceExecutor<AppContext, TermDetailRow> = {
  connection: async ({ ctx, cursor, direction, plan, take }) => {
    const decoded = decodeCursor(cursor);
    // decoded is Array<unknown> aligned to plan.root.orderBy. For a single
    // orderBy field, decoded[0] is the cursor value.

    const args = plan.root.args ?? {};
    const stub = ctx.env.PANO_POST.get(ctx.env.PANO_POST.idFromName('search'));

    const rows = await stub.searchPosts({
      query: args.query as string,
      cursor: decoded?.[0] as string | undefined,
      direction,
      take: take + 1, // fate uses take+1 to detect hasMore — your store should too
    });

    return rows;
  },
};
```

Fate handles cursor encoding/decoding via `encodeCursor` / `decodeCursor`
helpers but **only the executor knows how to apply the cursor to its
backing store** — that's the point of writing one.

For DO sources where the store does keyset pagination internally, you can
treat the cursor as opaque and forward it: the DO returns a slice plus a
`nextCursor` and fate's connection wrapper handles `hasMore` from
`take + 1`.

## Composing multiple sources

Phoenix needs Drizzle (`*Summary` from D1) **and** DO sources (`*Detail`)
in the same fate server. The `SourceResolver` interface is the
composition point:

```ts
import { createDrizzleSourceAdapter, createSourceRegistry } from '@nkzw/fate/server';

const drizzleAdapter = createDrizzleSourceAdapter<AppContext>({
  db: (ctx) => ctx.db,
  schema,
  views: { termSummaryView, postSummaryView /* ... */ },
});

const doSources = new Map([
  [termDetailView, termDetailSource],
  [postDetailView, postDetailSource],
  [userView, userSource],
]);

const doRegistry = createSourceRegistry<AppContext>([
  [termDetailSource, termDetailExecutor],
  [postDetailSource, postDetailExecutor],
  [userSource, userExecutor],
]);

// Merge the two registries into one map. Drizzle's adapter already owns
// the registry for its views; we union ours on top.
const mergedRegistry = new Map([
  ...drizzleAdapter.registry,
  ...doRegistry,
]);

export const sources = {
  getSource: (target) => {
    if ('view' in target && 'id' in target) return target;
    const fromDO = doSources.get(target);
    if (fromDO) return fromDO;
    return drizzleAdapter.getSource(target);
  },
  registry: mergedRegistry,
};

export const fate = createFateServer<AppContext>({
  roots: { /* mixes Drizzle + DO views freely */ },
  sources,
});
```

`getSource` is called whenever fate needs to turn a `DataView` reference
inside a `roots` / `queries` / `mutations` resolver into a runnable plan.
Throw a useful error for unknown views — wrong views are otherwise
silent until a request hits.

## Skipping the registry entirely (bespoke resolvers)

For one-off detail types you can skip the source machinery and just write
a regular query/mutation resolver. The view still gets registered, but
the source is a stub:

```ts
export const fate = createFateServer<AppContext>({
  queries: {
    termDetail: {
      type: 'TermDetail',
      resolve: async ({ ctx, input }) => {
        const stub = ctx.env.SOZLUK_TERM.get(
          ctx.env.SOZLUK_TERM.idFromName(input.args.slug as string),
        );
        const row = await stub.getDetail({
          viewerId: ctx.sessionUser?.id,
          fields: input.select,
        });
        return row; // returned shape must match selected fields
      },
    },
  },
  // ...
});
```

This skips `plan.resolve` so you lose normalization unless you do it
yourself. Use this for:

- One-off types with no `byId(s)` / `connection` shape (e.g. a singleton
  `viewer`)
- Prototypes where you haven't earned the executor abstraction yet
- Stuff that's never a relation target — fate can't follow a relation
  to a view that has no registered source

Rule of thumb: if more than one place loads the type, write a real
source. The registry path gives free relation following + cache keying.

## Phoenix-specific notes

**ID conventions.** For `*Detail` types the natural key is whatever the
DO is sharded on (`slug` for terms, ULID for posts). Composite IDs like
`${slug}:${ulid}` work — fate keys cache by `__typename:id` strings, so
composites are free. The DO executor parses the prefix to route.

**Selection passthrough.** Don't send fate's full plan to the DO. Build a
flat field list in the DO method signature:
`getDetail({ viewerId, fields: Array<'definitionCount' | 'definitions' | 'myVote'> })`.
Lets the DO compute exactly what was asked.

**`myVote` and viewer-scoped computed fields.** Compute these inside the
DO with one sqlite `LEFT JOIN` against the vote table — not via fate's
`computed` (which is built around the Drizzle/Prisma `count` hidden-deps
pattern). DO returns the value in the row; the executor doesn't see it
specially.

**Effect runtime.** Executors are plain async. Pass the per-request
`GraphQLRuntime`-equivalent through `AppContext` — build it in
`createFateServer({ context })` middleware and run any Effect-based
service calls inside the executor:

```ts
const termDetailExecutor: SourceExecutor<AppContext, TermDetailRow> = {
  byId: async ({ ctx, id, plan }) =>
    ctx.runtime.runPromise(
      SozlukService.getTermDetail(id, { fields: [...plan.root.selectedFields] }),
    ),
};
```

**Live events.** Sources don't emit live events. Mutations (or the
projection step inside a workflow) call `live.update('TermDetail', slug,
{ changed: ['definitionCount'] })`. The bus is independent of the
source machinery.

## Gotchas

- **`createSourceDefinition` vs Drizzle adapter.** The Drizzle adapter
  builds its own `SourceDefinition`s internally with relation metadata
  filled in. If you `createSourceDefinition` for a view the Drizzle
  adapter also owns, you'll have two definitions for the same view and
  `getSource` will pick whichever you wrote last. Don't double-register —
  pick one source per view.

- **Relations between custom and Drizzle sources.** `SourceDefinition`'s
  `relations` field needs `foreignKey` / `localKey` strings. The Drizzle
  adapter infers these from Drizzle schema. If a custom source has a
  relation to a Drizzle source (or vice versa), you must declare the
  relation explicitly on the custom definition. Easier path: return the
  related entity inline (`getDetail()` returns `{ ...term, definitions:
  [...] }`) and skip declaring it as a fate relation. The trade-off is
  losing normalized-cache deduping for the nested entities.

- **`id` field.** Fate uses `source.id` as the cursor field of last
  resort and the cache key. Default `'id'` works for most rows; override
  for slug-keyed entities.

- **`byIds` and `byId`.** If you only implement `byId`, fate falls back to
  `Promise.all(ids.map(byId))` for `byIds`. Implement `byIds` directly
  when there's a real batch path (single DO `getDefinitions(ids)` call
  vs N RPCs).

- **No `connection`?** Then any root list or relation that targets this
  source will throw at request time. Implement it, or don't expose the
  view as a list.

- **Workers + buffers.** `encodeCursor` / `decodeCursor` use `Buffer` —
  fine on Node, OK on `workerd` (polyfilled). For lighter cursors in a
  custom store, just return your store-native cursor string and skip
  fate's helpers.

## Reference: the contract in one block

```ts
type SourceExecutor<Context, Item, ByIdExtra = unknown, ByIdsExtra = unknown, ConnectionExtra = unknown> = {
  byId?: (opts: {
    ctx: Context;
    extra?: ByIdExtra;
    id: string;
    plan: SourcePlan<Item, Context>;
  }) => Promise<Item | null>;

  byIds?: (opts: {
    ctx: Context;
    extra?: ByIdsExtra;
    ids: Array<string>;
    plan: SourcePlan<Item, Context>;
  }) => Promise<Array<Item>>;

  connection?: (opts: {
    ctx: Context;
    cursor?: string;
    direction: 'backward' | 'forward';
    extra?: ConnectionExtra;
    plan: SourcePlan<Item, Context>;
    skip?: number;
    take: number;
  }) => Promise<Array<Item>>;
};

type SourceResolver<Context> = {
  getSource: <Item>(target: DataView<Item> | SourceDefinition<Item>) => SourceDefinition<Item>;
  registry: Map<SourceDefinition, SourceExecutor<Context>>;
};
```

Everything else — `createDrizzleSourceAdapter`, `createPrismaSourceAdapter`,
the `dataView` builders, `withConnection` — is sugar on top.

## Files to read in `@nkzw/fate`

- `packages/fate/src/server/source.ts` — `SourceDefinition`,
  `createSourcePlan`, cursor helpers
- `packages/fate/src/server/executor.ts` — `SourceExecutor`,
  `SourceRegistry`, `resolveSourceById/ByIds/Connection`
- `packages/fate/src/server/http.ts` — `createFateServer`,
  `SourceResolver`, how `sources.registry` is looked up per request
- `packages/fate/src/server/drizzle.ts` — full reference implementation
  (~1700 lines, but the executor at the bottom is the only part you
  imitate)
