# phoenix

kamp.us, reborn.

A single Cloudflare Worker. React 19 + Effect-ts v4 + Hono + GraphQL Yoga.
Durable Objects added incrementally for code/request co-location.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (single worker, assets + main) |
| Frontend | React 19 + Vite 8 + SWC |
| Backend | Hono + GraphQL Yoga |
| Effect system | `effect@4.0.0-beta.65` (tracks `effect-smol`) |
| Type-checking | `@effect/tsgo` (10× tsc + Effect LSP) |
| Lint / format | Biome 2 |
| Test | Vitest 4 |
| Orchestrator | Turbo |
| Package manager | pnpm 10 + workspace catalog |

## Getting started

```bash
pnpm install
pnpm dev          # turbo runs `vite` (SPA/HMR) + `alchemy dev` (worker) — two processes
pnpm typecheck    # effect-tsgo --noEmit -p ...
pnpm lint         # biome check
pnpm format       # biome check --write
```

## Layout

```
phoenix/
├── apps/
│   └── web/                 # the single worker (SPA + API)
│       ├── worker/          # worker entry + backend
│       └── src/             # React frontend
├── packages/                # shared internal packages
└── pnpm-workspace.yaml
```

## Lineage

- Tech rebuilt from `~/code/github.com/kamp-us/kampus/`
- Products reborn from `~/code/github.com/kamp-us/monorepo/` (sozluk, pano, kampus)
- Single worker model: SPA assets + Hono + DOs all in one worker.
