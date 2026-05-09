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
