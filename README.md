# phoenix

kamp.us, reborn. A coherent framework on Cloudflare Workers + alchemy + Effect + fate, collapsed into a single worker.

## Quickstart

```bash
pnpm install
pnpm dev          # vite (SPA + HMR) + alchemy dev (worker on local workerd)
pnpm typecheck    # effect-tsgo, project-references
pnpm deploy       # vite build + alchemy deploy (use --stage <name> for isolation)
```

`alchemy dev` runs the worker locally in `workerd`, but the platform resources it binds (D1, the live-fan-out DOs) are real Cloudflare resources in your personal dev stage. There is no offline emulator; see ADR 0032 for why.

## What phoenix is

One Cloudflare Worker that serves the SPA shell, the data plane, and every backend route. Frontend is React 19 + Vite, built to `dist/client` and served via the worker's `assets` binding with `runWorkerFirst` precedence for the worker-owned paths (`/api/*`, `/fate`, `/fate/*`). Backend is one Effect program — infra and runtime in the same file — that declares its bindings, hosts its Durable Objects, and returns a `fetch` handler.

It is **not** a generic framework for everyone. It is the opinionated stack the kamp.us products are built on (sozluk, pano, vote, stats), captured deliberately enough that future contributors and agents can extend it without rediscovering the choices.

Tech is rebuilt from the original `kamp-us/kampus` worker; products are reborn from the `kamp-us/monorepo`. The shape is `kampus`, the products are `monorepo`, collapsed into one worker.

## Stack

| Layer | Choice | What it does for phoenix |
|---|---|---|
| Infra + runtime | [alchemy](https://alchemy.run) `2.0.0-beta.45` | One Effect program declares the worker, bindings, DOs, and migrations. No `wrangler.jsonc`. |
| Effect system | `effect@4.0.0-beta.74` | Backend control flow, services, layers, errors, tracing. |
| Data protocol | [fate](https://github.com/usirin/fate) | Native protocol: `/fate` for data views, `/fate/live` for live views over SSE. Server types are the schema; no codegen artifact between server and client. |
| HTTP | `effect/unstable/http` | `HttpApiBuilder` for typed JSON groups, imperative `HttpRouter` for raw-Request/SSE routes. No Hono, no GraphQL. |
| Auth | `@alchemy.run/better-auth` | BetterAuth on D1 via a forked `CloudflareD1` Layer; session secret read from the `BETTER_AUTH_SECRET` binding (fail-closed — no default, `Effect.orDie` if missing). |
| DB | Drizzle on D1 | `Drizzle` is a worker-level singleton; feature code destructures `run`/`batch` capability methods. |
| DO storage | `state.storage` KV | The single `LiveDO` persists subscriber rows + generation as KV entries on `state.storage`; no per-DO SQL schema or migrations. |
| Frontend | React 19 + Vite 8 + react-fate | Components declare views; one batched `useRequest` per screen; declarative mutations; live views over SSE. |
| Type-check | `@effect/tsgo` | 10× tsc plus Effect's LSP. |
| Lint / format | Biome 2 | Tabs, 100 col, no bracket spacing. |
| Package manager | pnpm 10 (workspace catalog) | All commands use `pnpm`; `pnpm dlx` instead of `npx`. |

## Architecture at a glance

The worker has exactly five top-level concepts (ADR 0036):

```
apps/web/
├── alchemy.run.ts         # the stack — declares state mode + yields the worker
└── worker/
    ├── index.ts           # worker entry — DO host, bindings, env block
    ├── env.ts             # deploy-time env resolver + runtime env type
    ├── db/                # D1 binding, Drizzle schema, migrations, keyset cursors
    ├── http/              # router composition (app.ts) + the health route
    └── features/          # everything else, each in its own named folder
        ├── fate/          # data-layer plumbing — bridge, layers, barrels
        ├── fate-live/     # live SSE plane — the unified LiveDO (KV-backed)
        ├── pasaport/      # auth — better-auth fork + session capability
        ├── sozluk/        # product — dictionary
        ├── pano/          # product — link aggregator
        ├── vote/          # product — mutation-only
        ├── stats/         # product — query-only
        └── text/          # utility — excerpt()
```

`features/` is the home for **any named app-level grouping** — product domains, framework concerns, single-file utilities alike. There is no `services/`, `shared/`, `infra/`, or `admin/` bucket; those dissolve on purpose. If it has a coherent name worth grouping, it's a feature; otherwise it's runtime context and lives next to `features/`.

One Durable Object exists: `LiveDO`. A single class plays both roles — per-connection SSE stream holder and per-topic subscriber registry + fan-out — distinguished by instance-name prefix (`connection:` vs `topic:`). It addresses its sibling instances through its own namespace, resolved once at init, so every RPC method's `R` stays `never` — there is no per-call sibling resolution. Subscriber rows + `generation` persist as `state.storage` KV entries; no per-DO SQL schema or migrations (ADR 0028 for the Effect DO model; ADR 0037 unified the earlier split, superseding 0025/0033).

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies. |
| `pnpm dev` | Two processes: `vite` (SPA, HMR) and `alchemy dev` (worker, on workerd). |
| `pnpm dev:web` | Just the Vite SPA dev server. |
| `pnpm dev:worker` | Just `alchemy dev` (worker only, API-only). |
| `pnpm build` | `vite build` into `dist/client`. |
| `pnpm deploy` | `pnpm build && alchemy deploy`. Append `--stage <name>` for isolation. |
| `pnpm typecheck` | `effect-tsgo` across project references. |
| `pnpm test` | Vitest integration suite — deploys a `test` stage, runs against the live worker URL. |
| `pnpm lint` | `biome check .`. |
| `pnpm format` | `biome check --write .`. |

## Where to read deeper

The codebase is documented in two surfaces: ADRs (`.decisions/`) capture the *why* of each choice; patterns (`.patterns/`) describe *how* the current code is shaped. Read the patterns when writing code; read the ADRs when revisiting a decision.

Highest-leverage entry points for a new contributor:

| Doc | Why read it |
|---|---|
| [ADR 0032](./.decisions/0032-alchemy-beta45-and-dev-model.md) | The foundational dev model — alchemy deploys infra to real Cloudflare, runs the worker locally in workerd. |
| [ADR 0036](./.decisions/0036-features-as-any-named-app-grouping.md) | The structural principle — what counts as a feature, and what doesn't. |
| [.patterns/alchemy-runtime.md](./.patterns/alchemy-runtime.md) | The worker runtime — no per-request `ManagedRuntime`, worker-level layers, captured ServiceMap. The fate↔domain seam. |
| [.patterns/fate-effect-bridge.md](./.patterns/fate-effect-bridge.md) | The seam between the fate protocol and the Effect domain. Read first when touching server-side fate code. |
| [.patterns/per-feature-fate-aggregators.md](./.patterns/per-feature-fate-aggregators.md) | The per-feature footprint — `queries.ts` / `lists.ts` / `views.ts` / `shapers.ts` / `sources.ts` / `mutations.ts`. |

Full indexes: [.decisions/index.md](./.decisions/index.md) and [.patterns/index.md](./.patterns/index.md). New decisions go through `/adr`.

When the docs and `apps/web/worker/` disagree, the source is authoritative — fix the doc.

## Conventions

- **Effect is the backend control flow.** Services are `Context.Service` classes; methods are `Effect.fn("Service.method")` for free spans; errors are `Data.TaggedError`. Validation lives in service methods, never the route layer (ADR 0013).
- **One service per feature folder.** Reads and writes coexist. Admin operations get a parallel `<Feature>Admin` service with its own Layer (ADR 0012).
- **fate is pure transport; Effect services are the domain.** Reads and writes go through service methods — fate never queries the database. The `createDrizzleSourceAdapter` is never used.
- **One batched request per screen.** A screen root declares its whole view tree in a single `useRequest`; child `useView` calls read from cache. No waterfalls; no imperative cache updaters.
- **Make invalid states unrepresentable. Domain logic in domain objects.**
- **pnpm over npm.** All commands use `pnpm`; never `npx`, always `pnpm dlx`.
- **Biome formatting:** tabs, 100 col, no bracket spacing.
- **No `export default`** (ADR 0001) except where the framework demands it (`alchemy.run.ts`, the worker's `Phoenix.make(...)`, Vite entry).

## Sözlük seed

There is no seeding mechanism in the worker. The `ENVIRONMENT`-gated `/api/admin/*` seeder routes and the `import-sozluk`/`import-pano` scripts were deleted — gating destructive ops (`/clear` wipes all terms) behind a mutable `ENVIRONMENT` string was fail-open, and the importers were throwaway data-population. sözlük/pano persist via Drizzle+D1, so any future re-seed is a direct-D1 script against the bound database, not a runtime route on the public worker.
