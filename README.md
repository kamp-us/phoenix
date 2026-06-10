# phoenix

kamp.us, reborn. A single Cloudflare Worker on alchemy + Effect + fate that serves the SPA, the data plane, and every backend route.

It is not a general-purpose framework. It is the opinionated stack the kamp.us products (sozluk, pano, vote, stats) are built on, written down precisely enough that you can extend it without reverse-engineering the choices.

## Quickstart

```bash
pnpm install
pnpm dev          # vite (SPA + HMR) + alchemy dev (worker on local workerd)
pnpm typecheck    # effect-tsgo across project references
pnpm deploy       # vite build + alchemy deploy (use --stage <name> for isolation)
```

`alchemy dev` runs the worker locally in `workerd`, but the resources it binds — D1, the live Durable Object — are **real** Cloudflare resources in your personal dev stage. There is no offline emulator (ADR [0032](./.decisions/0032-alchemy-beta45-and-dev-model.md)).

## Stack

| Layer | Choice | What it does for phoenix |
|---|---|---|
| Infra + runtime | [alchemy](https://alchemy.run) `2.0.0-beta.45` | One Effect program declares the worker, its bindings, and the Durable Object. No `wrangler.jsonc`. |
| Effect system | `effect@4.0.0-beta.74` | Backend control flow, services, layers, errors, tracing. |
| Data protocol | [fate](https://github.com/usirin/fate) | `/fate` for data views, `/fate/live` for live views over SSE. Server types are the schema — no codegen artifact between server and client. |
| HTTP | `effect/unstable/http` | `HttpApiBuilder` for typed JSON groups, imperative `HttpRouter` for raw-Request and SSE routes. No Hono, no GraphQL. |
| Auth | `@alchemy.run/better-auth` | BetterAuth on D1 (magic-link + bearer + email/password) via a forked `CloudflareD1` Layer. Session secret comes from the `BETTER_AUTH_SECRET` binding — no default, fails closed if it is missing. |
| DB | Drizzle on D1 | `Drizzle` is a worker-level singleton; feature code calls its `run`/`batch` capability methods. |
| Live state | `LiveDO` on `state.storage` KV | One Durable Object fans out SSE. State is KV — subscriber rows + a per-connection counter. No DO SQL, no DO migrations. |
| Frontend | React 19 + Vite 8 + react-fate | Components declare views; one batched `useRequest` per screen; declarative mutations; live views over SSE. |
| Type-check | `@effect/tsgo` | Fast `tsc` plus Effect's LSP. |
| Lint / format | Biome 2 | Tabs, 100 col, no bracket spacing. |
| Package manager | pnpm 10 (workspace catalog) | All commands use `pnpm`; `pnpm dlx`, never `npx`. |

## Architecture

phoenix is a pnpm monorepo with effectively one app — the worker in `apps/web`. The docs live alongside the code: `.decisions/` for the *why*, `.patterns/` for the *how*.

One worker serves the React SPA (built to `dist/client`, served via the `assets` binding) and the API. It keeps precedence on its own paths — `/api/*`, `/fate`, `/fate/*` — and hands everything else to the SPA. The backend is one Effect program: it declares its bindings, hosts the Durable Object, and returns a `fetch` handler.

```
apps/web/
├── alchemy.run.ts         # the stack — state mode + the worker resource
└── worker/
    ├── index.ts           # entry — DO host, bindings, layer assembly
    ├── env.ts             # deploy-time env resolution (fails closed)
    ├── db/                # D1 binding, Drizzle schema, migrations, keyset cursors
    ├── http/              # router composition (app.ts) + health route
    └── features/          # every named grouping, one folder each
        ├── fate/          # the fate config + route, layer assembly, barrels
        ├── fate-live/     # the live SSE plane — LiveDO + LivePublisher + protocol
        ├── pasaport/      # auth — better-auth fork + session capability
        ├── sozluk/        # product — dictionary
        ├── pano/          # product — link aggregator
        ├── vote/          # product — votes
        ├── stats/         # product — read-only counts
        └── text/          # utility — excerpt()
```

`features/` is the home for **any** named app-level grouping — product domains, framework concerns, and single-file utilities alike. If a concern has a coherent name worth grouping, it's a feature; the few things that aren't (entry, env, db, http) sit beside `features/` (ADR [0036](./.decisions/0036-features-as-any-named-app-grouping.md)).

**The runtime.** Services are built once and live for the isolate — `Drizzle`, the feature layers, and the composed `FateServer` are assembled into one worker-level `ManagedRuntime` in `worker/index.ts`, not per request. A request to `/fate` provides only the per-request pair (`CurrentUser`, `LivePublisher`) as values; the compile step (`@phoenix/fate-effect`) runs each handler through the runtime. Handlers carry no leftover requirements. Read [.patterns/alchemy-runtime.md](./.patterns/alchemy-runtime.md) and [.patterns/fate-effect-compiler.md](./.patterns/fate-effect-compiler.md) before touching server-side fate code.

**The live plane.** A single Durable Object, `LiveDO`, fans out SSE. One class plays both roles — it holds a tab's stream (`connection:<id>`) and owns a data key's subscriber registry and fan-out (`topic:<key>`), told apart by instance-name prefix. It reaches its sibling instances through its own namespace, resolved once at init, so every RPC method stays requirement-free. State is `state.storage` KV: subscriber rows plus a per-connection counter that invalidates dead instances. Mutations reach the DO through the per-request `LivePublisher` service, whose publish methods are `Effect<void>` — a failed publish cannot fail the committed mutation. Read [.patterns/effect-sse-externally-driven.md](./.patterns/effect-sse-externally-driven.md); ADRs [0037](./.decisions/0037-unified-void-aligned-live-do.md) (the DO) and [0039](./.decisions/0039-livebus-context-service.md) (the publish-capability service, since folded into `LivePublisher`) are the design.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies. |
| `pnpm dev` | Two processes: `vite` (SPA, HMR) and `alchemy dev` (worker on workerd). |
| `pnpm dev:web` | Just the Vite SPA dev server. |
| `pnpm dev:worker` | Just `alchemy dev` (worker only). |
| `pnpm build` | `vite build` into `dist/client`. |
| `pnpm deploy` | `pnpm build && alchemy deploy`. Append `--stage <name>` for an isolated worker + D1 + DO. |
| `pnpm typecheck` | `effect-tsgo` across project references. |
| `pnpm test` | Integration suite — boots the stack on local workerd in `globalSetup`, runs the black-box HTTP suite against it. |
| `pnpm lint` | `biome check .`. |
| `pnpm format` | `biome check --write .`. |

## Conventions

- **Effect is the backend control flow.** Services are `Context.Service` classes; methods are `Effect.fn("Service.method")` for free spans; errors are `Data.TaggedError`. Input validation lives in service methods, not the route layer (ADR [0013](./.decisions/0013-validation-in-service-methods.md)).
- **One service per feature folder**, with reads and writes together. A feature owns its full footprint — `queries.ts` / `lists.ts` / `views.ts` / `shapers.ts` / `sources.ts` / `mutations.ts` ([.patterns/per-feature-fate-aggregators.md](./.patterns/per-feature-fate-aggregators.md)).
- **fate is pure transport; Effect services are the domain.** Reads and writes go through service methods — fate never touches the database (ADR [0016](./.decisions/0016-fate-pure-transport-effect-services-domain.md)).
- **One batched request per screen.** A screen root declares its whole view tree in a single `useRequest`; child `useView` calls read from cache. No waterfalls, no imperative cache updaters.
- **No type assertions.** `as any` and `as unknown as` are banned in source (enforced by a Biome GritQL rule); decode at runtime boundaries with `Schema` instead.
- **Make invalid states unrepresentable.** Domain logic lives in domain objects.
- **No `export default`** (ADR [0001](./.decisions/0001-no-export-default.md)) except where the framework demands it (`alchemy.run.ts`, the worker entry, Vite config).
- **pnpm, not npm.** Biome formatting: tabs, 100 col, no bracket spacing.

Data tasks (seeding, backfills) are one-off direct-D1 scripts against the bound database, not worker routes.

## Where to read deeper

Two doc surfaces carry the rest: **[.decisions/](./.decisions/index.md)** holds the ADRs — the *why* behind each choice and the history of how it got here; **[.patterns/](./.patterns/index.md)** describes *how* the current code is shaped. Read a pattern when you're about to write that kind of code; read an ADR when you want to revisit a decision. New decisions go through `/adr`. When a doc and `apps/web/worker/` disagree, the source wins — fix the doc.

**New here? Read in this order:**

1. This file — the shape and the rules.
2. ADR [0032](./.decisions/0032-alchemy-beta45-and-dev-model.md) — the dev model: real Cloudflare resources, worker runs locally.
3. [.patterns/alchemy-runtime.md](./.patterns/alchemy-runtime.md) + [.patterns/fate-effect-compiler.md](./.patterns/fate-effect-compiler.md) — how an HTTP request becomes domain code.
4. [.patterns/per-feature-fate-aggregators.md](./.patterns/per-feature-fate-aggregators.md) — the footprint you'll copy when adding a feature.

Then open the feature folder you're working in and follow its neighbors.
