# phoenix

kamp.us, reborn.

A single Cloudflare Worker. React 19 + Effect + fate.
HTTP via Effect `HttpRouter` / `HttpApiBuilder` (ADR 0027). Durable Objects
authored on alchemy's Effect DO model (ADR 0028).

## Architecture

- **One worker** serves both the SPA (via `assets` binding) and the API.
- The data layer is [fate](https://github.com/usirin/fate)'s native protocol: `/fate` serves data views, `/fate/live` drives live views over SSE. Other backend routes live under `/api/*`.
- Frontend is React 19 + Vite, built into `dist/client`.
- DOs are bindings on the same worker: `ConnectionDO` + `TopicDO` power the fate-live SSE fan-out (ADRs 0023/0025/0028). Add more DOs per feature.

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
cp apps/web/.env.example apps/web/.env   # first run only — local dev env (gitignored)
pnpm dev          # turbo-driven; two processes: `vite` (SPA/HMR) + `alchemy dev` (worker)
pnpm dev:web      # just the Vite SPA dev server
pnpm dev:worker   # just `alchemy dev` (the worker on a local workerd, offline)
pnpm build
pnpm deploy       # pnpm build && alchemy deploy (use --stage <name> for isolation)
pnpm typecheck
pnpm lint         # biome check
pnpm format       # biome check --write
```

`alchemy dev` auto-loads `apps/web/.env` (it layers a `.env` over `process.env`), so `BETTER_AUTH_SECRET` (a required `Config.redacted`, no default) and `ENVIRONMENT` come from there — copy `.env.example` → `.env` once. Production secrets are Cloudflare `secret_text` bindings set by `alchemy deploy`, never read from `.env`.

Deploy is alchemy-managed (ADR 0026–0031): `alchemy.run.ts` is the stack, there is
no `wrangler.jsonc`. `alchemy deploy --stage <name>` yields an isolated worker + D1
+ DOs per stage; CI uses the Cloudflare-hosted state store, local dev uses
`Alchemy.localState()` (offline).

## pnpm over npm

- All commands use `pnpm`.
- Never use `npx ...`; use `pnpm dlx ...`.

## Lineage

- Tech is rebuilt from `~/code/github.com/kamp-us/kampus/` (worker + DO patterns).
- Products are reborn from `~/code/github.com/kamp-us/monorepo/` (sozluk, pano, kampus).
- The shape is `kampus`, the products are `monorepo`, collapsed into one worker.

## Conventions

- Biome formatting: tabs, 100 col, no bracket spacing.
- Effect for backend control flow; feature services are isolate-level layers, with only `Auth` provided per request (ADR 0029).
- Make invalid states unrepresentable. Domain logic in domain objects.
- **Ground Effect API/design decisions in effect-smol's `LLMS.md`** (and its `ai-docs/` examples) **over intuition** — when the documented idiom and a "cleaner" instinct conflict, the documented idiom wins; cite it by section. Deviations from it must be justified by a real platform constraint (e.g. CF isolates have no shutdown hook), not preference.
- **If you rely on a pattern not yet in `.patterns/`, add or extend a doc for it** (per the "When to add a new pattern doc" criteria in [.patterns/index.md](./.patterns/index.md)) — don't leave a load-bearing pattern undocumented.
- In-repo docs: standard markdown links (`[text](relative/path.md)`), not Obsidian `[[wikilinks]]`; use real resolvable paths, no placeholders.
- Doc surfaces: `README` = current state for builders (never carry retired or old-problem context a new reader has no frame for); `.decisions/` = the why + history, including superseded approaches; `.patterns/` = how the current code is shaped.

## Decisions

See [.decisions/index.md](./.decisions/index.md) — read the row, open the file when you need the why. Record new decisions with `/adr`.

## Patterns

See [.patterns/index.md](./.patterns/index.md) — evergreen patterns for writing phoenix backend code (services, errors, testing, layer wiring). Read before adding a new feature or service.

When the docs and `apps/web/worker/` disagree, the source is authoritative — fix the doc.

## Filing follow-up work

The moment you spot work you won't do right now — a bug, a refactor you're not here to make, a design question, an investigation, a missing test, a confusing convention — file it as a GitHub issue with the [`report`](.claude/skills/report/SKILL.md) skill, then return to your task. Do this **autonomously and in-the-moment**: don't ask permission, don't propose-first, don't wait until you're "done" (by then the observation is gone). The skill files a type-blind issue tagged `status:needs-triage` and nothing else — classifying and prioritizing is triage's job, not yours. This is the only sanctioned way observations leave a session; a follow-up that lives only in the conversation is a follow-up that dies there.

## Sözlük seed

There is no seeding mechanism in the worker. The `ENVIRONMENT`-gated `/api/admin/*` seeder routes + the `import-sozluk`/`import-pano` scripts were deleted (a fail-open security hole; throwaway data-population). sözlük/pano persist via Drizzle+D1, so any future re-seed is a direct-D1 script against the bound database, not a runtime route on the public worker.
