# phoenix

kamp.us, reborn.

A single Cloudflare Worker. React 19 + Effect + Hono + GraphQL Yoga.
Durable Objects (added incrementally) for code/request co-location.

## Architecture

- **One worker** serves both the SPA (via `assets` binding) and the API.
- Backend routes live under `/graphql`, `/api/*`, `/rpc/*`.
- Frontend is React 19 + Vite, built into `dist/client`.
- DOs are bindings on the same worker (none yet — added per feature).

```
phoenix/
├── apps/
│   └── web/                 # the single worker
│       ├── worker/          # worker entry + backend code
│       ├── src/             # React frontend
│       └── wrangler.jsonc
├── packages/                # shared internal packages
└── pnpm-workspace.yaml
```

## Commands

```bash
pnpm install
pnpm dev          # turbo-driven; runs `wrangler dev` for the worker
pnpm build
pnpm typecheck
pnpm lint         # biome check
pnpm format       # biome check --write
```

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

## Sözlük seed

Content lives in `~/code/github.com/kamp-us/monorepo/packages/sozluk-content/terms`, NOT in this repo. To seed the local Sozluk DO:

1. `pnpm dev` — worker must be running on localhost:3000
2. `pnpm --filter @phoenix/web sozluk:import` (append `-- --clear` to wipe first, `-- --base-url=...` to target a different worker)

The DO endpoints `POST /api/admin/sozluk/upsert-term` and `POST /api/admin/sozluk/clear` are dev-only — guarded by `ENVIRONMENT === "development"`. The importer is idempotent: re-runs skip terms and definitions that already exist.
