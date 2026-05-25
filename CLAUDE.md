# phoenix

kamp.us, reborn.

A single Cloudflare Worker. React 19 + Effect + Hono + fate.
Durable Objects (added incrementally) for code/request co-location.

## Architecture

- **One worker** serves both the SPA (via `assets` binding) and the API.
- The data layer is [fate](https://github.com/usirin/fate)'s native protocol: `/fate` serves data views, `/fate/live` drives live views over SSE (via `LiveDO`). Other backend routes live under `/api/*`, `/agents/*`.
- Frontend is React 19 + Vite, built into `dist/client`.
- DOs are bindings on the same worker (none yet — added per feature).

```
phoenix/
├── apps/
│   └── web/                 # the single worker
│       ├── worker/          # worker entry + backend code
│       ├── src/             # React frontend
│       └── alchemy.run.ts   # the alchemy stack (replaces wrangler.jsonc)
├── packages/                # shared internal packages
└── pnpm-workspace.yaml
```

## Commands

```bash
pnpm install
pnpm dev          # turbo-driven; two processes: `vite` (SPA/HMR) + `alchemy dev` (worker)
pnpm dev:web      # just the Vite SPA dev server
pnpm dev:worker   # just `alchemy dev` (the worker on a local workerd, offline)
pnpm build
pnpm deploy       # pnpm build && alchemy deploy (use --stage <name> for isolation)
pnpm typecheck
pnpm lint         # biome check
pnpm format       # biome check --write
```

Deploy is alchemy-managed (ADR 0026–0031): `alchemy.run.ts` is the stack, there is
no `wrangler.jsonc`. `alchemy deploy --stage <name>` yields an isolated worker + D1
+ DOs per stage; CI uses the Cloudflare-hosted state store, local dev uses
`Alchemy.localState()` (offline). Re-seed a deployed stage with
`node --experimental-strip-types apps/web/scripts/import-sozluk.ts --base-url=<url>`.

## pnpm over npm

- All commands use `pnpm`.
- Never use `npx ...`; use `pnpm dlx ...`.

## Lineage

- Tech is rebuilt from `~/code/github.com/kamp-us/kampus/` (worker + DO patterns).
- Products are reborn from `~/code/github.com/kamp-us/monorepo/` (sozluk, pano, kampus).
- The shape is `kampus`, the products are `monorepo`, collapsed into one worker.

## Conventions

- Biome formatting: tabs, 100 col, no bracket spacing.
- Effect for backend control flow; resolvers run via a per-request runtime.
- Make invalid states unrepresentable. Domain logic in domain objects.

## Decisions

See [.decisions/index.md](./.decisions/index.md) — read the row, open the file when you need the why. Record new decisions with `/adr`.

## Patterns

See [.patterns/index.md](./.patterns/index.md) — evergreen patterns for writing phoenix backend code (services, errors, testing, layer wiring). Read before adding a new feature or service.

When the docs and `apps/web/worker/` disagree, the source is authoritative — fix the doc.

## Sözlük seed

Content lives in `~/code/github.com/kamp-us/monorepo/packages/sozluk-content/terms`, NOT in this repo. To seed the local Sozluk DO:

1. `pnpm dev` — worker must be running on localhost:3000
2. `pnpm --filter @phoenix/web sozluk:import` (append `-- --clear` to wipe first, `-- --base-url=...` to target a different worker)

The DO endpoints `POST /api/admin/sozluk/upsert-term` and `POST /api/admin/sozluk/clear` are dev-only — guarded by `ENVIRONMENT === "development"`. The importer is idempotent: re-runs skip terms and definitions that already exist.
