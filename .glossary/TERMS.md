# phoenix domain vocabulary (TERMS)

The repo-owned vocabulary spine: the **nouns of phoenix** — the products, the
domain entities, the backend/fate/testing/infra terms a contributor or a
CI-spawned agent must share to read the codebase the same way. Each term gets a
short canonical definition and, where it disambiguates a known naming drift, a
note on what the term is **not**.

This file **churns** — it lags shipped surfaces over time as features land and
names move. It is maintained incrementally (not hand-frozen); when the code and
this file disagree, the code is authoritative and this file is the doc to fix.

The *why* and binding decisions live in [`.decisions/`](../.decisions/index.md);
how the current code is shaped lives in [`.patterns/`](../.patterns/index.md).
This file names the *what*.

## Core / shape

| Term | Definition | Not |
|---|---|---|
| kamp.us | The product/site being reborn as phoenix. | |
| kampus | Three senses: (1) the tech-lineage shape (worker + Durable Object patterns phoenix is rebuilt from); (2) the site-shell product (landing, profile, auth); (3) the **`kampus` client CLI** — the one authenticated surface humans + agents use to hit the deployed kamp.us API (ADR 0045; designed, not built). | "server" |
| phoenix | This project: kamp.us reborn as a single Cloudflare Worker (React 19 + Effect + fate, alchemy-managed). | |
| Worker | The one Cloudflare Worker serving both the SPA (via `ASSETS`) and the API: `/fate` (data), `/fate/live` (SSE), `/api/*` (health, auth). HTTP via Effect `HttpRouter` / `HttpApiBuilder` — no Hono, no GraphQL. | "server" |

## Products (domains)

| Term | Definition | Not |
|---|---|---|
| imge | Product (designed — ADR 0044; **not built**): an imgur-style image/video host backed by Cloudflare R2, auth'd against the pasaport user; agents upload via an `apiKey` credential. Originating need: hosting report-agent screenshots + pano/sözlük markdown images. | |
| pano | HN-style link & discussion aggregator with threaded comments. Turkish for "board". | "board", "pinboard" |
| pasaport | Identity/auth/profiles/karma domain; wraps better-auth. Turkish for "passport". | "auth" (broader) |
| report (bildir) | The content-reporting **feature** (`features/report`): users flag a post/comment/definition for moderation. Turkish brand name **bildir**. | the `/report` pipeline skill or the report-*agent* (which file GitHub issues) — unrelated |
| rss / feed | The feed-generation feature (`features/rss`): emits RSS/Atom feeds of pano/sözlük activity. | |
| sözlük (sozluk) | Turkish dev-terms dictionary; community definitions ranked by upvotes. Turkish for "dictionary". | "dictionary" |
| stats | Landing-page aggregate counts (query-only feature). | |
| text | Small shared text-utility "app" under `features/` — a named grouping, not a product domain. | a product domain |
| vote | Shared vote + karma write engine; sözlük and pano delegate to it; owns the `user_vote` table. | |

## Domain entities

| Term | Definition | Not |
|---|---|---|
| comment | A threaded reply on a pano post. | |
| contribution | An item in a profile's activity feed (a definition/post/comment); a discriminant-tagged fate view. | |
| definition | A community-written meaning under a sözlük term; upvotable; its `score` is its net up-vote tally. | |
| karma | Reputation points; the vote engine writes karma deltas atomically with votes (same Drizzle batch). | "rep" (use karma) |
| künye | Per-user Durable Object holding karma; powers invite-only access, karma-gated privileges, agent registration. Turkish for "byline/credits". (Planned achievement system.) | |
| post | A pano submission (link or text). | |
| profile | A user's public page with a contributions feed; carries `totalKarma`. | |
| score | A definition/post/comment's net up-vote tally; a denormalized cache bumped inside the vote batch. | |
| tag | A label on a pano post. | |
| term | A sözlük dictionary entry (has a slug + title). | "word" |

## Backend architecture (Effect)

| Term | Definition | Not |
|---|---|---|
| AppConfig | The `Config.all(...)` surface for reading worker env (e.g. `ENVIRONMENT`); bare `effect/Config`, no WorkerEnvironment cast. | |
| Auth | The capability service carrying the resolved session; the ONE genuinely per-request service (ADR 0029). | |
| BETTER_AUTH_SECRET | The signing secret, bound `secret_text` via `Config.redacted` (REQUIRED, no default); read in `better-auth-live.ts`. | |
| Context.Service | The Effect service class form; one per feature folder (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`). | |
| Data.TaggedError | The tagged-error model; each `_tag` maps to a wire code. | a plain `Error` |
| Database (tag) | The Effect service holding the raw `D1Database`; the swappable DB seam both `Drizzle` and better-auth derive from, so features and auth share ONE handle. `DatabaseLive` binds `PHOENIX_DB`; `DatabaseTest` is a scoped in-memory handle (ADR 0040). | passing concrete `db`/`auth` handles |
| Drizzle (service) | Worker-level singleton holding the drizzle builder; the DB seam for feature code (`worker/db/Drizzle.ts`). Derives its handle from the `Database` tag. | drizzle (the library) |
| `Drizzle.run` / `Drizzle.batch` | Callbacks feature code uses for single / atomic-multi queries; wrap `Effect.tryPromise` with a tagged `DrizzleError`. `batch` is atomic (all-or-none). | a raw `Effect.tryPromise` |
| Effect.fn | Service-method wrapper giving auto spans + stack frames; span names are `"Service.method"`. | |
| ENVIRONMENT | Plain `plain_text` binding gating better-auth's dev/prod split; the sole real runtime consumer is `better-auth-live.ts`. | |
| HttpApiBuilder | Effect's typed-JSON HTTP layer; serves the `GET /api/health` group (`health.ts`). | |
| HttpRouter | Effect's imperative router; raw-`Request`/SSE routes (`/fate`, `/fate/live`, `/api/auth/*`) via `HttpRouter.add`. Replaced Hono (ADR 0027). | Hono |
| keyset | Cursor pagination helpers (`worker/db/keyset.ts`): `KeysetPage`, `keysetAfter`, `forwardPage`. The page-envelope vocabulary. | offset pagination |
| worker runtime | The ONE isolate-level `ManagedRuntime` (worker singletons + the composed `FateServer`) the compile step runs every fate handler through; built once in worker init, never disposed on Cloudflare (ADRs 0041/0042). | a per-request runtime |

## fate (the data layer)

| Term | Definition | Not |
|---|---|---|
| fate | The Relay-inspired typed data client (`@nkzw/fate`); the data layer end to end (GraphQL + Relay torn out). | GraphQL, Relay |
| data view (dataView) | fate's per-entity field declaration. Views are the schema. **A fate data view is a read-shape declaration, NOT a Drizzle table** — see the `definition_record`/`comment_record` store-of-record note below (#853). The `_record`-suffixed Drizzle tables were renamed off `*_view` precisely so "view" is reserved for fate data views (`DefinitionView`/`CommentView`). | a GraphQL type; a Drizzle store-of-record table |
| ConnectionResult | fate's connection payload (`items` + `pagination`). | Edge, PageInfo |
| Entity\<\> | The type a resolved view produces; the shared client/server type contract. | |
| LiveDO | The unified **void**-aligned live-view Durable Object — ONE class, two roles, `state.storage` KV. Fans out mutations' `live.*` events to subscribers over SSE (ADR 0037). | two classes named ConnectionDO + TopicDO (see below) |
| ConnectionDO / TopicDO | The **former, superseded** two-class live-view design. Today there is ONE class, `LiveDO`, with two **roles** (connection, topic) dispatched via `resolveRole(state.id.name)` — not two Durable Object classes (ADR 0037). | live Durable Object class names (they are roles of LiveDO, not classes) |
| void | The upstream live-streaming Durable Object reference (`VoidLiveStreamDurableObject`) that **LiveDO** mirrors; the design authority for LiveDO's `DEFAULT_LIMITS`, the queue-full→`410` behavior, the first-failed-probe reap, and the stale/replay model. | inventing LiveDO limits/reap semantics from scratch |
| role (connection / topic) | LiveDO's two roles: **connection** owns one client's SSE stream + subscriptions; **topic** owns a topic's subscriber registry, publish fan-out, and reap alarm. | |
| shaper | Maps a DB row to an `Entity` field set (`shapers.ts`). | |
| source | A `Fate.source(ViewClass, {id}, handlers)` loader entry delegating to Effect services (`sources.ts`); fate never queries D1. The loader half (silent reads). | a source that throws not-found |
| useView / useListView | Client hooks reading a single entity / a paginated list from the normalized cache. | |
| useLiveView / useLiveListView | Client hooks subscribing a view/list to live SSE updates. Drop-in for the non-live variants. | |
| useRequest | Client hook resolving a screen's whole composed view tree in one batched request. | |
| ViewRef | A normalized handle to an entity (type + id), not its data; resolved via `useView`. | |

## fate-effect

| Term | Definition | Not |
|---|---|---|
| fate-effect | The workspace package (`packages/fate-effect`): fate's structure × Effect's semantics — phoenix's anti-corruption layer over fate. Core exports: `Fate`, `FateDataView`, `FateServer`, `FateInterpreter` (the native serving path the `/fate` route runs — ADR 0043), `LivePublisher` (+ `CurrentUser`) (ADR 0042). | rewriting fate |
| Fate constructors | `Fate.query/list/mutation/source` — value constructors pairing a pure-data definition (Schema input, success view, declared error union) with an `Effect.fn` handler. | raw generators as handlers |
| FateServer | The package-owned service tag (HttpRouter idiom — one server per worker). `FateServer.layer(config)` is the only composite; init-time throws for duplicate wire names and sourceless entities. | per-feature server tags |
| FateInterpreter | The native Effect serving path the `/fate` route runs (`FateInterpreter.handleRequest`) — no runtime on the request path, RequestResolver batching, spans nesting under the router's request span (ADR 0043). | the compiled `FateExecutor` path (the differential-oracle baseline only) |
| fateWireCode | **The one canonical name** for the fate wire-error `code` concept — the error-class annotation the codec derives wire codes from; one edit per new error. The SPA list is guarded against drift by `apps/web/worker/features/fate/wireCodes.unit.test.ts`. **This is one concept under one name**, not `ErrorCode` / "wire code" / `MutationErrorCode` / `ScreenErrorCode` / "boundary" spelled five ways across the encode→decode seam (#851). | a `WIRE_CODE_BY_TAG`-style registry; four-plus different names for one concept |
| LivePublisher | The per-request live-publish service whose publish is `Effect<void, never>` — `waitUntil` + error-swallowing live inside the layer (`livePublisherFor`), once. Provided per request alongside `CurrentUser`. | |
| loader / resolver split | source = loader (the dataloader byIds workhorse; `E = never`, absence = fewer rows) vs operations = resolvers (domain ops, typed errors). Reads silent, writes loud. | a source that throws on not-found |

## Testing

| Term | Definition | Not |
|---|---|---|
| test taxonomy (T0–T3) | The four test tiers (ADR 0040): **T0** pure (no SQL engine), **T1** service-integration (real service over in-memory `node:sqlite`), **T2** bridge/app-integration (full fate over in-memory SQL, no workerd), **T3** system (deployed `workerd` over real remote D1). A tier is *which layer satisfies a fixed R-channel*, not a folder. | calling any SQLite-booting test a "unit" test |
| T0 / `*.unit.test.ts` | The pure-test naming convention inside the existing `unit` vitest project (the `unit` glob catches it). | a third vitest project |
| makeSqliteTestDb | Test-kit factory: a fresh in-memory `node:sqlite` D1 handle with `foreign_keys` OFF (D1 parity) + baseline migration applied. A factory, never a shared instance. | a shared instance |
| makeDatabaseTest | The scoped `DatabaseTest` layer provisioning + closing an in-memory handle; provided inside each `it.effect` for per-test isolation. | `it.layer` for isolation (it builds once per `describe`) |
| runFateOp | Test-kit helper running a fate operation through the compiled fate server over a per-op disposed `ManagedRuntime`; returns `{status, result, published}`. | copy-pasted inline `fateOp` bodies |

## Infra / store

| Term | Definition | Not |
|---|---|---|
| alchemy (alchemy-effect) | The infra-as-Effect layer: one Effect program for infra + runtime, replacing `wrangler.jsonc`, the Hono entry, manual binding access, and hand-written DO classes (ADR 0026). | wrangler |
| alchemy.run.ts | The stack definition (`Alchemy.Stack`) declaring the worker + D1 + DOs; replaces `wrangler.jsonc`. | |
| ASSETS | The static-assets binding serving the built SPA from `dist/client`. | |
| D1-direct | The architecture (ADR 0009): resolvers read/write D1 directly — no projection layer. | |
| `definition_record` / `comment_record` (Drizzle tables) | The authoritative **mutated stores of record** for sözlük definitions and pano comments (D1-direct, ADR 0009; Drizzle exports `definitionRecord` / `commentRecord`). Renamed off the projection-era `definition_view` / `comment_view` (#853) — that old name lied about the module kind and collided one capital apart with the fate `DefinitionView` / `CommentView` data views in the same feature folders. The `_record` suffix reads as "store of record" and stays distinct from the fate data-view tags (bare `definition`/`comment` was rejected because it would overlap those tags). **These tables are stores of record, NOT fate data views.** | a read-projection; the fate `DefinitionView` / `CommentView` data views |
| `@kampus/db-schema` | The leaf package (`packages/db-schema`) holding the ONE canonical Drizzle declaration of the **shared** D1 tables — `term_summary`, `definition_record`, `post_summary`, `comment_record` — that more than one consumer reads. Depends only on `drizzle-orm`, so the worker, `@kampus/preview-seed`, and `@kampus/fts-backfill` all import it with no dependency cycle; the worker schema re-exports it. Replaces the three hand-mirrored copies whose silent column drift was caught only by real-D1 CI (#859/#903). | worker-only tables (better-auth, votes, stats, `user_profile`, `content_report`) or the FTS5 virtual tables — those stay worker-private |
| localState | `Alchemy.localState()` — the offline state store for local dev; CI/deploy use the Cloudflare-hosted store (ADR 0031). | |
| PHOENIX_DB | The single D1 database; the canonical store for every product table. ALWAYS a real remote Cloudflare DB (no offline local D1) even in dev/integration. | an offline local D1 |
| R2 / R2Bucket | Cloudflare object-storage binding that will back **imge** (ADR 0044); net-new infra — **NOT yet in `alchemy.run.ts`**. | |
| secret_text / plain_text | alchemy worker binding kinds; `Config.redacted` → `secret_text`, plain `Config` → `plain_text`. | |
| stage | `alchemy deploy --stage <name>` → an isolated worker + D1 + DOs per stage. | |
| workerd | The local Workers runtime the dev worker and the integration-test deploy run on (sidecar). Needs Node 26 (Node 25 breaks the spawn). | miniflare |

## Feature flags (shipped — ADRs 0081/0093)

| Term | Definition | Not |
|---|---|---|
| Flagship | **Cloudflare Flagship** — the chosen feature-flag substrate (ADR 0081); phoenix reads flags server-side + in React and drives Flagship's attribute targeting + consistent-hash percentage rollout. | a home-grown flag table, env-var flags |
| feature flag | A named, runtime-flippable toggle gating a code path; the containment seam for **ship-behind-flag** delivery. Declared per a naming grammar + lifecycle convention ([`.patterns/feature-flags-schema-lifecycle.md`](../.patterns/feature-flags-schema-lifecycle.md)). | |
| ship-behind-flag | The agent delivery workflow ([`.patterns/feature-flags-agent-workflow.md`](../.patterns/feature-flags-agent-workflow.md)): merge a feature dark behind a flag, validate in production, then a human flips it on (ADR 0083, deploy-vs-release). | |
| flag targeting / percentage rollout | Flagship attribute targeting + consistent-hash percentage rollout ([`.patterns/feature-flags-targeting.md`](../.patterns/feature-flags-targeting.md)) — the same user always lands the same arm. | |

## Search (FTS — shipped, ADR 0080)

| Term | Definition | Not |
|---|---|---|
| site search | v1 is a **lexical search bar** (`/search?q=`), not semantic discovery — ADR 0080 splits the two. | semantic search (a separate product) |
| term_search / post_search | The SQLite **FTS5** virtual tables backing sözlük/pano search; kept current by a dual-write sync path off `term_summary` / `post_summary`. | |
| fts-backfill | Direct-D1 one-time CLI re-indexing existing summary rows into the FTS5 tables through the dual-write path (`packages/fts-backfill`). | a runtime backfill route |

## Run-evidence / CI gating (ADRs 0054/0056/0058/0092)

| Term | Definition | Not |
|---|---|---|
| run-evidence bundle | A SHA-bound, machine-readable manifest of a CI run the merge gates trust instead of prose (ADR 0054). | trusting prose / a green checkmark alone |
| crabbox | The run-evidence pipeline: `crabbox-manifest` (pure transform: run-summary + JUnit + logs → manifest) feeding the gate consumers ([`.patterns/crabbox-run-evidence.md`](../.patterns/crabbox-run-evidence.md)). | |
| SHA-bound verdict | A gate verdict pinned to the exact head SHA it reviewed (ADR 0058); a re-push invalidates it. | an unpinned PASS comment |
| fail-closed gate | The ADR 0092 invariant: a gate whose enforcement scans **zero scope** must fail, never silently no-op. | a silent no-op gate |
| control-plane | The `.claude/` + `.github/` + gate-critical-skills surface a human merges by hand; the pipeline refuses to self-ship it (ADRs 0053/0063/0065). | an agent-merged control-plane PR |

## Apps

| Term | Definition | Not |
|---|---|---|
| apps/web (@phoenix/web) | The ONE app/worker today — serves the SPA (via `ASSETS`) + the API. The multi-app structure (ADR 0057) exists but `web` is the sole occupant. | |
