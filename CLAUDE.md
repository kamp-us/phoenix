# phoenix

kamp.us, reborn.

A multi-app, multi-worker repo: one Cloudflare Worker per app under `apps/`
(`web` is the only app today), each its own package + stack + stage (ADR
0057). React 19 + Effect + fate. HTTP via Effect `HttpRouter` / `HttpApiBuilder`
(ADR 0027). Durable Objects authored on alchemy's Effect DO model (ADR 0028).

## Architecture

- **One worker per app.** Each `apps/<app>` is its own pnpm package owning its own
  `alchemy.run.ts` stack + per-app stage, reusing the account-global state store and
  the four CI secrets — no second bootstrap (ADR 0057). `apps/web` is the only worker
  today; the structure fans out as apps are added.
- **`apps/web`** serves both the SPA (via `assets` binding) and the API.
- The data layer is [fate](https://github.com/usirin/fate)'s native protocol: `/fate` serves data views, `/fate/live` drives live views over SSE. Other backend routes live under `/api/*`.
- Frontend is React 19 + Vite, built into `dist/client`.
- DOs are bindings on the same worker: a single unified `LiveDO` (ADR 0037, on the Effect DO model of ADR 0028) plays both the connection and topic roles to power the fate-live SSE fan-out (ADRs 0023/0025). Add more DOs per feature.

```
phoenix/
├── apps/                    # one worker per app, each its own package + stack (ADR 0057)
│   └── web/                 # @kampus/web — the only worker today
│       ├── worker/          # worker entry + backend code
│       ├── src/             # React frontend
│       └── alchemy.run.ts   # this app's alchemy stack (replaces wrangler.jsonc)
├── packages/                # shared internal packages
├── infra/                   # standalone stacks: ci-credentials (one-shot CI-token provisioner), depo (internal asset store/CDN — designed, ADR 0144)
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
- The shape is `kampus`, the products are `monorepo`, collapsed into the `apps/web` worker.

## Conventions

- Biome formatting: tabs, 100 col, no bracket spacing.
- **Node over Python for scripts/hooks.** Mechanical tooling lives as an Effect CLI package under `packages/` (the `epic-ledger` / `crabbox-manifest` / `leak-guard` idiom — `effect/unstable/cli`, run with `node src/bin.ts`), not an ad-hoc script or a Python hook. A pure, unit-tested core + a thin Effect bin; never a one-off `.py`. The pipeline tools fold into one router, `pipeline-cli <tool> …` ([`packages/pipeline-cli/`](packages/pipeline-cli/)); before hand-rolling `gh`/`jq`/`git` glue, reach for an existing tool — for the full one-line-per-tool `name · purpose` map **on demand**, run `pipeline-cli commands compact` (generated from the registry, never auto-injected; mirrors the ADR-discovery `decisions-index compact` contract below).
- Effect for backend control flow; feature services are isolate-level layers, with the per-request services (`CurrentUser`, `LivePublisher`, `CurrentActor`) provided onto each handler from the validated session (ADRs 0029/0041; `CurrentActor` per ADR 0107 §7). `Auth` is a BetterAuth type alias, not the per-request session carrier — `CurrentUser` (ADR 0042) is.
- Make invalid states unrepresentable. Domain logic in domain objects.
- **Comments earn their place or die.** Code must not be buried between comments a reader pattern-matches as boilerplate and skips — a skipped comment is pure noise that rots unread. Not anti-comment: a load-bearing note is the point. But the *why* belongs in `.decisions/`, how-the-code-is-shaped in `.patterns/`; an inline comment is the surface of last resort, for a note with no other home that belongs at this exact line (a local invariant at its enforcement site, a workaround + its forcing constraint, a deliberate-looking-wrong guard, a pragma rationale). Cut separators, name-restaters, and narration of obvious control flow; collapse a docblock that re-derives an ADR's *why* to a pointer (`// See ADR NNNN`). A top-of-file docblock is fine when it states what the module is + the one non-obvious thing — not an essay re-deriving the code. Enforce with [`/deslop-comments`](.claude/skills/deslop-comments/SKILL.md).
- **Ground falsifiable claims about platform/runtime/dependency behavior in source, not intuition.** Any decision-driving claim about how a platform, runtime, or dependency *behaves* — D1/workerd/CF-isolate semantics, an engine's tokenizer/collation, a binding's resolution, a library's API contract — that an ADR or a diagnosis rests on must be verified against the authoritative source (the dep's source/docs, a spec, or an actual test against the real platform) and cited, never asserted from intuition. (ADR 0040 rested on the unverified "`node:sqlite` is the same engine as D1"; ADR 0082 then had to tear out the four-tier taxonomy it grew into.) The canonical instance: **ground Effect API/design decisions in effect-smol's `LLMS.md`** (and its `ai-docs/` examples) over intuition — when the documented idiom and a "cleaner" instinct conflict, the documented idiom wins; cite it by section. Deviations from a grounded source must be justified by a real platform constraint (e.g. CF isolates have no shutdown hook), not preference.
- **If you rely on a pattern not yet in `.patterns/`, add or extend a doc for it** (per the "When to add a new pattern doc" criteria in [.patterns/index.md](./.patterns/index.md)) — don't leave a load-bearing pattern undocumented.
- In-repo docs: standard markdown links (`[text](relative/path.md)`), not Obsidian `[[wikilinks]]`; use real resolvable paths, no placeholders.
- Doc surfaces: `README` = project/product front door (what kamp.us is — products + ethos; never carry retired or old-problem context a new reader has no frame for); `DEVELOPMENT.md` = current build/dev state for builders (quickstart, stack, architecture, commands, conventions, the pipeline); `.decisions/` = the why + history, including superseded approaches; `.patterns/` = how the current code is shaped; `.glossary/` = the canonical vocabulary (architecture terms + product/brand nouns); [`design-system-manifest.md`](./design-system-manifest.md) = the CLAUDE.md-for-design — the four-pillars design law (ADR 0162) as an agent-readable manifest `write-code` reads before generating any UI (role-token annotations, component-selection rules, per-pillar prohibitions).
- **Every `packages/*` workspace package carries a `README.md`** (what it is, why it exists, how to use it) — a package with no README has no entry point for a reader or consumer. Enforced fail-closed in CI by `pipeline-cli readme-guard check` (the `readme-guard.yml` job), which scopes to real workspace members (dirs with a `package.json`) so it ignores dead-shell dirs and fails closed on zero scope (ADR 0092).
- **A mutation over a fate-live fanned entity must publish the `/fate/live` invalidation.** A `Fate.mutation` that writes an entity in a subscribed connection (`Post` / `Comment` / `Definition`) must, after the write, publish through `WorkerLivePublisher` — omitting it silently staleness-breaks every other client's live view (the publisher's error channel is `never`, so nothing forces it; #1893–#1896 all shipped the omission). Every mutation is classified fanned/not in [`apps/web/worker/features/fate-live/fanned-mutations.ts`](apps/web/worker/features/fate-live/fanned-mutations.ts), and `pipeline-cli fanout-guard check` (the `fanout-guard.yml` job) fails closed on an unclassified mutation, a fanned mutation whose feature omits the publish, or zero scope (ADR 0155/0092).
- Decisions are product-driven by default; engineering leads only on platform/infra (the pipeline, fate/DO substrate, infra primitives) — see ADR [0078](.decisions/0078-product-driven-decisions-by-default.md).
- **Turkish for product/brand, English for technical.** Product/brand names and user-facing copy stay Turkish; everything technical is English — URL routes/paths, code identifiers, D1 table/column names, file names. The canonical vocabulary lives in [`.glossary/LANGUAGE.md`](.glossary/LANGUAGE.md) — read it; the brand-noun list and the architecture terms (module / interface / depth / seam / …) are defined there, not duplicated here.
- **Every dependency via `catalog:`.** Each dep in any `package.json` is sourced from the pnpm workspace `catalog:` (declared once in `pnpm-workspace.yaml`), never a hardcoded version string — one shared version per dep across the repo. When a dep is also a transitive dep of something already in the tree, catalog it at the EXACT version that parent links (don't introduce a second version). Enforced fail-closed in CI by `pipeline-cli catalog-guard check` (the `catalog-guard.yml` job), which scans the root and every workspace member `package.json` (`dependencies`/`devDependencies`/`peerDependencies`) and reds on any non-`catalog:`/`workspace:` version or on zero scope; a genuinely unavoidable exception lives in the guard's explicit reasoned allowlist, never a silent tolerance (ADR 0092; #2737). Incident: PR #535 hardcoded `@distilled.cloud/cloudflare` and broke frozen-lockfile CI.

## Decisions

The ADRs live in [`.decisions/`](./.decisions/) — one `NNNN-slug.md` per decision, the *why* in each file's body. There is no committed index (ADR [0126](./.decisions/0126-ambient-adr-discovery.md)) and **no `SessionStart` ADR-map hook** (ADR [0129](./.decisions/0129-adr-discovery-is-the-claude-md-contract.md), dropping 0126's hook as needless indirection): discovery is *this* contract, the same in every context (session, subagent, CI). Discover ADRs by `ls .decisions/` — the `NNNN-slug` filenames are the map — plus each file's frontmatter (`id`/`title`/`status`) for the row; for the full one-line-per-ADR `id · title · status` map **on demand**, run `pipeline-cli decisions-index compact` (never auto-injected). Open the file when you need the why. Record new decisions with `/adr`.

## Vocabulary

See [.glossary/LANGUAGE.md](./.glossary/LANGUAGE.md) — the canonical architecture vocabulary (module / interface / implementation / depth / seam / adapter / leverage / locality + the deletion test), extended with phoenix's own structural terms (the two test tiers — unit / integration, the fate loader/resolver split, the LiveDO connection/topic roles) and the product/brand nouns. This is the single source for those terms; don't redefine them inline.

## Patterns

See [.patterns/index.md](./.patterns/index.md) — evergreen patterns for writing phoenix backend code (services, errors, testing, layer wiring). Read before adding a new feature or service.

When the docs and `apps/web/worker/` disagree, the source is authoritative — fix the doc.

## Filing follow-up work

The moment you spot work you won't do right now — a bug, a refactor you're not here to make, a design question, an investigation, a missing test, a confusing convention — file it as a GitHub issue with the [`report`](.claude/skills/report/SKILL.md) skill, then return to your task. Do this **autonomously and in-the-moment**: don't ask permission, don't propose-first, don't wait until you're "done" (by then the observation is gone). The skill files a type-blind issue tagged `status:needs-triage` and nothing else — classifying and prioritizing is triage's job, not yours. This is the only sanctioned way observations leave a session; a follow-up that lives only in the conversation is a follow-up that dies there.

## Sözlük seed

There is no seeding mechanism in the worker, and cold-start content seeding is a founder-declared v1 non-goal: the first cohort is the two founders writing as users, and new yazars arrive by vouch (kefil) + moderation — no imported/seeded corpus is planned. **Security guard (load-bearing):** no runtime seeder route may be rebuilt on the public worker — the deleted `ENVIRONMENT`-gated `/api/admin/*` seeder routes + the `import-sozluk`/`import-pano` scripts were a fail-open security hole.
