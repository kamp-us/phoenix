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
| bildirim | The notification **feature** (`features/bildirim`, epic #1666): the recipient-keyed store + read model behind the `/bildirimler` center page and the topbar **unread badge** — the `notification` D1 table, the `Notification` domain service, and the `bildirim.*` fate views/mutations (`list` / `unreadCount` / `markRead` / `markAllRead`). Ships dark behind the single default-off `phoenix-bildirim` flag every emitter sibling reuses. Turkish for "notification". | the **report (bildir)** feature (content-reporting for moderation — `bildir`, a different lexeme and module); an emitter (siblings #1695–#1699 produce notifications; this is the spine) |
| divan | The proving-ground reviewer surface (`features/divan`): the gated destination where the established community (yazar + moderatör) reviews a çaylak's sandboxed work and promotes (mod-direct) or vouches (kefil) them toward yazar — work "goes before the divan". Reads the `sandboxBacklogWhere` backlog over a yazar-OR-mod gate. Turkish for "council/court". | a widening of inline çaylak visibility — it is a gated **destination** that reads the sandbox backlog, not a change to who sees sandboxed items inline |
| funnel / conversion funnel | The conversion-funnel readout (`features/funnel`, #1589): the mod-gated, dark-shipped surface that measures the human **çaylak→yazar** journey. Its tracer read is the **tier population** — a humans-only (`user.type = 'human'`) `GROUP BY tier` count of how many accounts sit at each rung of the authorship ladder (`FunnelSummary`, the `funnel.summary` fate view). Served behind the default-off `phoenix-funnel-readout` flag, read-gated by the `ViewFunnel` capability (founder/mod). The Phase-2 rate/time metrics extend this same service. | a public metrics page (founder/mod only, flag-gated); a per-product stat (that is **stats**, the landing counts); an agent/bot metric (humans-only by construction) |
| imge | Product (designed — ADR 0044; **not built**): an imgur-style image/video host backed by Cloudflare R2, auth'd against the pasaport user; agents upload via an `apiKey` credential. Originating need: hosting report-agent screenshots + pano/sözlük markdown images. | |
| pano | HN-style link & discussion aggregator with threaded comments. Turkish for "board". | "board", "pinboard" |
| pasaport | Identity/auth/profiles/karma domain; wraps better-auth. Turkish for "passport". | "auth" (broader) |
| report (bildir) | The content-reporting **feature** (`features/report`): users flag a post/comment/definition for moderation. The Turkish brand lexeme **bildir** lives on the **user-facing copy** (the `ReportButton` labels `bildir` / `bildirildi` / `zaten bildirildi`); the **technical** surface stays English per the convention — module dir `features/report`, the `Report` service, the `content_report` table. (No `bildir`-specific exemption is needed: report conforms — Turkish brand on the copy, English technical identifiers.) | the `/report` pipeline skill or the report-*agent* (which file GitHub issues) — unrelated |
| rss / feed | The feed-generation feature (`features/rss`): emits RSS/Atom feeds of pano/sözlük activity. | |
| sözlük (sozluk) | Turkish dev-terms dictionary; community definitions ranked by upvotes. Turkish for "dictionary". | "dictionary" |
| stats | Landing-page aggregate counts (query-only feature). | |
| text | Small shared text-utility "app" under `features/` — a named grouping, not a product domain. | a product domain |
| vote | Shared vote + karma write engine (`features/vote/Vote.ts`); sözlük and pano delegate to it. The per-target tables `definition_vote` / `post_vote` / `comment_vote` (PK `(target_id, voter_id)`) are the **score-truth source** — the cached `score` on the target row is rebuilt from `COUNT(*)` on them. The cross-product `user_vote` table (PK `(user_id, target_kind, target_id)`) is the **`myVote` presence mirror**, not the score truth. | the score-truth store (those are the per-target `*_vote` tables); `user_vote` is only the `myVote` mirror, not the authoritative score |

## Domain entities

| Term | Definition | Not |
|---|---|---|
| bookmark (kaydet) | A per-user post save — pure presence (a `post_bookmark` row means saved). The structural twin of **vote** stripped of score/karma: per-user presence row + batched `readMine` + `changed`-returning toggle. **One lexeme per layer, mirroring vote (#1138):** engine `Bookmark` (vote: `Vote`); per-target row `post_bookmark` (vote: `post_vote`); presence intent input `value` (vote: `value`); wire viewer-scalar + result presence field both `isSaved` (vote: both `myVote`). Two deviations are deliberate, not drift: the brand term stays Turkish **`kaydet`** (Turkish-product / English-technical split), and the wire scalar uses the **`is*`** convention (`isSaved`, the `isDraft` twin) where vote uses bare `myVote`. | the bare lexemes `saved`/`bookmarked` for the wire/result field (the field is `isSaved`); a score-bearing vote |
| comment | A threaded reply on a pano post. | |
| contribution | An item in a profile's activity feed (a definition/post/comment); a discriminant-tagged fate view. | |
| çaylak | The un-promoted tier on the earned-authorship ladder (`visitor < çaylak < yazar`): an authenticated contributor whose work is **sandboxed** — it goes before the **divan** for review before becoming public. Promoted to **yazar** when a yazar vouches (kefil) for them **and** a net-karma bar is met. The standing is read via `Kunye` against the ladder (ADR 0107; see the Authz section). Turkish for "rookie/novice". | a logged-out **visitor** or a banned account; a **yazar** (the promoted tier); a **moderatör** (the `Relation`-axis authority, a separate axis) |
| definition | A community-written meaning under a sözlük term; upvotable; its `score` is its net up-vote tally. | |
| karma | Reputation points; the vote engine writes karma deltas atomically with votes (same Drizzle batch). | "rep" (use karma) |
| künye | Two roles. **(1) Reputation DO — designed, not built (#41).** The *planned* per-user Durable Object for karma / invite-only access / karma-gated privileges / agent registration; **not shipped** — today the only Durable Object is `LiveDO`, karma lives in D1 (`user_profile.total_karma`), and `Kunye` (`features/kunye/Kunye.ts`) is a plain `Context.Service` (it reads standing fresh from pasaport, holds no DO state). **(2) The kamp.us authz home (ADR 0107)** — `apps/web/worker/features/kunye/` hosts the capability **instances** (`Authorship`, `Moderate`, `Admin`), the adapter **Layers** that fill `packages/authz`'s ports (`CurrentActorLive` ← pasaport session, `RelationStoreLive` ← D1 relation tuples, `AgentAuthorityV1`), and the earned-standing service — the authz / earned-standing half of the split. Turkish for "byline/credits". | authn/identity (that is **pasaport**); the vocab-free authz *mechanism* (that is **`packages/authz`**) |
| notification | One recipient-keyed `notification` row (bildirim): a plain-text `kind` (emitters mint kinds without a migration), a polymorphic target reference (`post`/`comment`/`definition`/`user`, no FK — liveness resolved at read time), an optional verbatim `actor_id`, an aggregate `count` slot ("3 yeni oy", #1698), and read state as a **nullable `read_at` stamp** — "read but we don't know when" is unrepresentable. Every read/write predicate carries `recipient_id`, so touching another user's notification matches zero rows by construction. | a row with a boolean `read` flag (read state is the `read_at` stamp); a cross-user broadcast |
| post | A pano submission (link or text). | |
| profile | A user's public page with a contributions feed; carries `totalKarma`. | |
| score | A definition/post/comment's net up-vote tally; a denormalized cache bumped inside the vote batch. | |
| tag | A label on a pano post. | |
| target tombstone | The render for a notification whose target no longer resolves: `foldTargetHrefs` (`features/bildirim/target.ts`) yields a `null` `targetUrl` for removed content or a deleted/unbootstrapped account, and the center page renders a plain dead row — never a broken link or a crash. | a deleted notification (the row stays, only its link is gone); a client-side 404 |
| term | A sözlük dictionary entry (has a slug + title). | "word" |
| unread badge | The topbar unread-count chip on the user menu: rendered only when the recipient's unread count > 0 (and `phoenix-bildirim` is on). Reads at shell mount; a mark-read receipt carries the fresh count, but live SSE refresh is #1700's lane. | an always-visible counter (absent at 0 or flag-off); a live-updating badge (that is #1700) |
| yazar | The promoted full-author tier on the earned-authorship ladder (`visitor < çaylak < yazar`): an established author whose work is no longer sandboxed and who reviews çaylak work in the **divan**, vouching (kefil) for a çaylak's promotion toward yazar. The floor for `OpenTerm` (open a sözlük başlık) and for casting a vouch (ADR 0107; see the Authz section). Turkish for "author/writer". | a **çaylak** (the un-promoted tier); a **moderatör** (the `Relation`-axis `moderates` authority, a separate axis) |

## Authz (capabilities — ADR 0107)

The vocab-free *mechanism* lives in `packages/authz`; the kamp.us *instances + standing* live in **künye** (`apps/web/worker/features/kunye/`). Depth is in [`.patterns/authz-capability-as-effect.md`](../.patterns/authz-capability-as-effect.md) + ADR [0107](../.decisions/0107-capability-authz-framework.md); this names the nouns.

| Term | Definition | Not |
|---|---|---|
| `packages/authz` | The vocab-free capability-as-Effect authorization **mechanism**: a privileged op requires an unforgeable `Grant` proof, obtained only by discharging a typed check and flowed through the Effect context (R) channel — omitting `.provide` is a compile error. Two axes: `Level` (the earned authorship ladder `visitor < çaylak < yazar`, a global account-level standing) and `Relation` (assigned, resource-scoped authority — `moderates`, `admin`). Declares the ports (`CurrentActor`, `RelationStore`, `AgentAuthority`) and names no kamp.us noun, no fate, no D1. | a central PDP / a stringly `decide(action)` boundary; better-auth's AC model (authn only); the kamp.us instances (those are **künye**) |
| capability | A class-as-capability named by *what it authorizes* (`Authorship`, `Moderate`, `Admin`) — the class is at once the proof tag, the `Grant` type, the discharge verb, and `.provide`. The kamp.us instances are künye-owned. | a level compared at the callsite; a `user.role` string check (retired, ADR 0107) |
| Authorship (OpenTerm / AddEntry) | The `Level`-axis künye capability rights (`features/kunye/Authorship.ts`): `OpenTerm` (floor `yazar`, open a sözlük başlık) and `AddEntry` (floor `çaylak`, add an entry), each a single `Capability.Level` flooring the global standing read from `Kunye` against the `visitor < çaylak < yazar` ladder and denying with `RequiresLevel` (`FORBIDDEN`). One class = one right (the tag IS the right). | a per-product standing; the sözlük write-path wiring (that is #1203); the `Relation` axis (`Moderate`/`Admin`) |
| AgentAuthority | The dormant **agent-attenuation seam** (ADR 0107 §6): an authz port that *combines* an agent's own + human-root standing so an agent's authority ⊆ its human root. v1 is humans-only — `features/kunye/AgentAuthorityV1` fills it **fail-closed** (an agent is admitted nothing); **v1.1 swaps that one Layer** for the real policy with no edit to `packages/authz`. The framework's additive-completeness litmus. | a capability/right; a check at the callsite; a `packages/authz` edit point |
| Tier / authorship ladder | The `visitor < çaylak < yazar` earned-authorship `Scale` (`features/kunye/standing.ts` `authorshipLadder`, ADR 0107 §4) the `Authorship`/`Vouch` `Capability.Level` instances floor against. Since #1203 the live tier is a **server-managed `user.tier` column** read via `Kunye.tierOf`, not derived from karma; `visitor` is never stored — it is only the read-time rank of a no-account principal, so an authenticated account is always `≥ çaylak`. | a karma-derived tier (the `tierForKarma` / `KARMA_THRESHOLDS` math survives only as the promotion/karma input); a `user.role` string |
| Vouch (kefil) | The author-vouch **capability** (`features/kunye/vouch.ts`, ADR 0107 §2-3): a `Capability.Level` floored at `yazar` — a yazar vouches for a çaylak's promotion. Its OWN right (named by what it authorizes) even though it shares `OpenTerm`'s yazar floor. `Vouch.require` discharges a `Grant` iff global standing `gte yazar`, else the public `RequiresLevel` (`FORBIDDEN`). Turkish user-facing copy: **kefil**. Routing the authority through the framework makes self-promotion structurally impossible. | an inline `if (tier === 'yazar')`; opening a term (that is `OpenTerm`); the vouch *record* (that is `VouchLedger`) |
| VouchLedger | The D1-backed **store of the vouch act** (`features/kunye/VouchLedger.ts`, the `authorship_vouch` table) — records / reads / counts / withdraws a yazar's vouch, preserving the voucher. **Active-by-existence** (#1289): no `withdrawn` column — a vouch is active iff its row exists AND the candidate is still `çaylak`; a promotion or a withdrawal frees the slot. The persistence seam only; the *authority* to vouch is the `Vouch` capability. Concurrent-vouch cap `VOUCH_CONCURRENT_CAP` (= 3). | the vouch authority (that is `Vouch`); a row carrying an active/withdrawn flag column |
| tandem (resolveTandem) | The **order-independent tandem resolver** (`features/pasaport/tandem.ts`, #1289): the single idempotent path that flips a çaylak → `yazar` the moment *both* halves hold — `(≥ 1 active vouch) AND (net karma ≥ VOUCH_PROMOTION_KARMA_BAR, = 15)`. Fired from both triggers (the vouch act and the bar-crossing vote) in either arrival order, so promotion never depends on which landed first. Holds **no authority** — it is not a capability; the yazar never holds a promote right (North Star #1194). | a promote capability; a karma-only auto-promotion (a vouch is always required) |

## Backend architecture (Effect)

| Term | Definition | Not |
|---|---|---|
| AppConfig | The `Config.all(...)` surface for reading worker env (e.g. `ENVIRONMENT`); bare `effect/Config`, no WorkerEnvironment cast. | |
| Auth | A **type alias** re-exporting better-auth's instance type — `export type Auth = BetterAuth` (`features/pasaport/Pasaport.ts`, `import type {Auth as BetterAuth} from "better-auth"`); the typed handle for the better-auth instance, **not** a session-carrying service. The per-request session carrier is **`CurrentUser`** (ADR 0042), provided per request alongside `LivePublisher`. | the per-request session service (that is `CurrentUser`, ADR 0042) |
| BETTER_AUTH_SECRET | The signing secret, bound `secret_text` via `Config.redacted` (REQUIRED, no default); read in `better-auth-live.ts`. | |
| Context.Service | The Effect service class form; one per feature folder (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Stats`). | |
| Data.TaggedError | The tagged-error model; each `_tag` maps to a wire code. | a plain `Error` |
| Database (tag) | The Effect service holding the raw `D1Database`; the swappable DB seam both `Drizzle` and better-auth derive from, so features and auth share ONE handle. `DatabaseLive` binds `PHOENIX_DB`. There is no test handle: `unit` tests substitute the higher `Drizzle` seam directly (a `Layer.succeed(Drizzle, …)` double) and provide no `Database`; the real handle exists only at `integration`, against real remote D1 (ADR 0082 — the in-memory `node:sqlite` `DatabaseTest` of ADR 0040 is deleted). | passing concrete `db`/`auth` handles |
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
| fateWireCode | **The one canonical name** for the fate wire-error `code` concept — the `FateWireCode` annotation key (`@kampus/fate-effect`) the codec derives wire codes from; one edit per new error. Both ends of the seam spell it `FateWireCode`: the package annotation key and the SPA literal-union type (`src/lib/fateWireCodes.ts`). The SPA list + the canonical export *name* are both guarded against drift by `apps/web/worker/features/fate/wireCodes.unit.test.ts`. **This is one concept under one name** (#851, consolidated #1032) — not the `ErrorCode` / `ScreenErrorCode` / "wire code" / "boundary" five-way spelling it drifted into. | a `WIRE_CODE_BY_TAG`-style registry; four-plus different names for one concept |
| CurrentUser | The per-request session carrier (`packages/fate-effect`, `CurrentUser.ts`): a `Context.Service` holding the resolved `CurrentUserInfo` (id / email / name / image) or `undefined` for anonymous traffic, provided per request alongside `LivePublisher` (ADR 0042). `CurrentUser.required` fails `UNAUTHORIZED` for an anonymous request. **This — not `Auth` — is the per-request session service.** | the better-auth instance type (that is `Auth`); a worker-level singleton (it is per-request) |
| LivePublisher | The per-request live-publish service whose publish is `Effect<void, never>` — `waitUntil` + error-swallowing live inside the layer (`livePublisherFor`), once. Provided per request alongside `CurrentUser`. | |
| loader / resolver split | source = loader (the dataloader byIds workhorse; `E = never`, absence = fewer rows) vs operations = resolvers (domain ops, typed errors). Reads silent, writes loud. | a source that throws on not-found |

## Testing

| Term | Definition | Not |
|---|---|---|
| test tiers (unit / integration) | The two live tiers (ADR 0082, extended by 0104). **unit** — pure logic + in-process service contracts, no DB: the `Drizzle` storage seam is *substituted*, no SQL engine, no deployed worker. **integration** — real behavior over **real remote Cloudflare D1** (+ DOs) via the alchemy `Test.make` idiom, black-box over HTTP/SSE. There is **no in-memory SQL tier**. | the retired T0–T3 four-tier model; a `node:sqlite` D1 stand-in (deleted #579) |
| `*.unit.test.ts` | The pure-test naming convention inside the `unit` vitest project (the glob catches both `*.unit.test.ts` and plain `*.test.ts` service-contract tests). | a third vitest project |
| runFateOp | **Deleted (ADR 0105).** The former in-process op-test harness running a fate operation through the compiled fate server over a per-op disposed `ManagedRuntime`. Removed as a zero-consumer dead end; interpreter dispatch is unit-tested in `fate-effect` (`Executor.test.ts` / `Codegen.test.ts`), route reachability at the `integration` tier (ADR 0082), and the light app seam is `resolveWire`. | a live test helper (it no longer exists) |

## Infra / store

| Term | Definition | Not |
|---|---|---|
| alchemy (alchemy-effect) | The infra-as-Effect layer: one Effect program for infra + runtime, replacing `wrangler.jsonc`, the Hono entry, manual binding access, and hand-written DO classes (ADR 0026). | wrangler |
| alchemy.run.ts | The stack definition (`Alchemy.Stack`) declaring the worker + D1 + DOs; replaces `wrangler.jsonc`. | |
| ASSETS | The static-assets binding serving the built SPA from `dist/client`. | |
| D1-direct | The architecture (ADR 0009): resolvers read/write D1 directly — no projection layer. | |
| `definition_record` / `comment_record` (Drizzle tables) | The authoritative **mutated stores of record** for sözlük definitions and pano comments (D1-direct, ADR 0009; Drizzle exports `definitionRecord` / `commentRecord`). Renamed off the projection-era `definition_view` / `comment_view` (#853) — that old name lied about the module kind and collided one capital apart with the fate `DefinitionView` / `CommentView` data views in the same feature folders. The `_record` suffix reads as "store of record" and stays distinct from the fate data-view tags (bare `definition`/`comment` was rejected because it would overlap those tags). **These tables are stores of record, NOT fate data views.** | a read-projection; the fate `DefinitionView` / `CommentView` data views |
| `@kampus/db-schema` | The leaf package (`packages/db-schema`) holding the ONE canonical Drizzle declaration of the **shared** D1 tables — `term_record`, `definition_record`, `post_record`, `comment_record` — that more than one consumer reads. Depends only on `drizzle-orm`, so the worker, `@kampus/preview-seed`, and `@kampus/fts-backfill` all import it with no dependency cycle; the worker schema re-exports it. Replaces the three hand-mirrored copies whose silent column drift was caught only by real-D1 CI (#859/#903). | worker-only tables (better-auth, votes, stats, `user_profile`, `content_report`) or the FTS5 virtual tables — those stay worker-private |
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
| `@kampus/cf-utils` | The **human-operated Cloudflare Flagship read/flip CLI** (`packages/cf-utils`, epic #1602): `node src/bin.ts flag <list\|get\|set>` reads and flips **Flagship** flags across every env from the terminal, so a release flip is a traceable, reviewable command instead of an untraceable dashboard click. Built on a typed Effect read client (`FlagshipRead`) wrapping the canonical `@distilled.cloud/cloudflare` flagship ops — the **same** transport `@kampus/d1-rest` runs D1 over, no third raw-`curl` copy (#941) — over a pure, unit-tested `decodeEnv`/`decodeFlagState` core; creds from `$CLOUDFLARE_API_TOKEN`/`$CLOUDFLARE_ACCOUNT_ID` at runtime, never source. | the flag **IaC** (declaring/creating flags — that stays in `apps/web/worker/features/flagship/resources.ts`); a dashboard flip; a new raw-`curl` client |

## Search (FTS — shipped, ADR 0080)

| Term | Definition | Not |
|---|---|---|
| site search | v1 is a **lexical search bar** (`/search?q=`), not semantic discovery — ADR 0080 splits the two. | semantic search (a separate product) |
| term_search / post_search | The SQLite **FTS5** virtual tables backing sözlük/pano search; kept current by a dual-write sync path off `term_record` / `post_record`. | |
| fts-backfill | Direct-D1 one-time CLI re-indexing existing summary rows into the FTS5 tables through the dual-write path (`packages/fts-backfill`). | a runtime backfill route |

## Run-evidence / CI gating (ADRs 0054/0056/0058/0092)

| Term | Definition | Not |
|---|---|---|
| run-evidence bundle | A SHA-bound, machine-readable manifest of a CI run the merge gates trust instead of prose (ADR 0054). | trusting prose / a green checkmark alone |
| crabbox | The run-evidence pipeline: `crabbox-manifest` (pure transform: run-summary + JUnit + logs → manifest) feeding the gate consumers ([`.patterns/crabbox-run-evidence.md`](../.patterns/crabbox-run-evidence.md)). | |
| SHA-bound verdict | A gate verdict pinned to the exact head SHA it reviewed (ADR 0058); a re-push invalidates it. | an unpinned PASS comment |
| fail-closed gate | The ADR 0092 invariant: a gate whose enforcement scans **zero scope** must fail, never silently no-op. | a silent no-op gate |
| control-plane | The `.claude/` + `.github/` + gate-critical-skills surface a human merges by hand; the pipeline refuses to self-ship it (ADRs 0053/0063/0065). | an agent-merged control-plane PR |
| right-sized fan-out (trivial-diff tier) | Routing a review to a gate sized to the diff: a **trivially-classified** PR takes the lighter gate instead of the full `review-code`/`review-doc`/`review-skill` fan-out, capturing the saving at the gate's *prompt cost*, never its *authority to FAIL* (ADR 0120). Shipped-but-dormant — off by default, adoption gated behind #1560's two-axis measurement (ADR 0112). Composed from the classifier (#1557) + the lighter gate (#1558) + the executor wiring (#1559); shaped in [`.patterns/right-sized-fan-out-trivial-tier.md`](../.patterns/right-sized-fan-out-trivial-tier.md). | skipping the gate for a small diff (ADR 0120 option (b), rejected); an adopted/on lever |
| trivial-diff classifier | The deterministic, fail-closed predicate (`pipeline-cli trivial-diff classify`, #1557) that marks a unified diff `trivial` **only** on a hard-AND of bounds — single small/doc-or-comment-only file, no new surface, and no path matching the **live** `CONTROL_PLANE_RE` re-resolved from `origin/main`. Any failed bound, parse error, or unreadable boundary ⇒ `non-trivial` (default-deny). | a taste/vibe call; a stale-boundary snapshot; a third "unknown" verdict |
| lighter gate (review-trivial) | The **reduced-prompt but still fail-closed** verify path (`review-trivial` skill, #1558) a trivially-classified diff can take: a tight scoped checklist (right change vs AC, no leaked secret, no leaked machine-local/home/absolute/sibling-repo path) run by an **independent** reviewer, emitting a SHA-bound PASS/FAIL in the **existing** review namespace. Re-affirms triviality itself and **DECLINEs** to the full path if the diff is not actually trivial. | a *skipped* gate (only the prompt cost is reduced, never the authority to FAIL); a self-review by the author (the split-role firewall holds); a new verdict marker namespace |

## rite-audit (the çaylak→yazar audit harness — epic #1510)

The judgment-audit harness for the earned-authorship rite: a deployed-stage walk that asks "can a real person complete the çaylak→yazar rite end to end, no human in the loop?", not "does each unit test pass". The explorer is a skill (`claude-plugins/kampus-pipeline/skills/rite-audit/`), the lifecycle/runner/serializer are the three `@kampus/audit-*` packages. This names the nouns; the contract depth is in the skill's `DIMENSIONS.md`.

| Term | Definition | Not |
|---|---|---|
| rite-audit | The authorship-rite **audit harness** (epic #1510): a *judgment* audit — "can a real person walk the whole **çaylak→yazar rite** end to end on a real deployed stage, no human in the loop?". The explorer is the `rite-audit` **skill** (`claude-plugins/kampus-pipeline/skills/rite-audit/`) — an LLM driving the Playwright MCP through the rite against a flag-on **audit stage**, emitting raw `Finding`s per **dimension** and handing them to the **Verdict** serializer. | a fixed Playwright spec suite / a unit-test tier; a run against production (only a flag-on `audit` stage) |
| rite (çaylak→yazar) | The earned-authorship **rite** the harness audits: the full walk from **çaylak** to **yazar** — self-register, write sandboxed work, get vouched (**kefil**) in the **divan**, watch the tier flip on the profile. The product subject of rite-audit; walkable only where `phoenix-authorship-loop` is forced on (the audit stage). | the authz *mechanism* (that is künye / `packages/authz`); a single capability check |
| dimension | The rite-audit **extension unit**: one self-contained vertical (its `surfaces` + `probe` explorer steps + pass/fail `rubric`) run over the same provisioned stage, emitting its own `Finding`s. One Markdown file under the skill's `dimensions/`, registered in the skill's *Active dimensions* table — adding one is "one file + one table row". Three active: **functional-rite** (#1513), **accessibility** / a11y (#1514), **sandbox-leak** (#1515). Contract in the skill's `DIMENSIONS.md`. | a check hardcoded into the harness; the verdict/archive (that is `@kampus/audit-verdict`) |
| Finding | The **atom** every rubric check emits — `{dimension, check, surface, status, expected, observed, evidence}` (`@kampus/audit-verdict` `src/schema.ts`, the TS rendering of `DIMENSIONS.md`). Grouped + diffed run-over-run on the **(dimension, check, surface) triple**, never the (dimension, check) pair — one check runs across several surfaces and the pair would collide them. `status` is `PASS` / `FAIL` / `BLOCKED`; **BLOCKED is never a pass** — it means could-not-be-evaluated and rolls up to FAIL (story 11). | a per-(check) record (the key is the triple); a "couldn't tell ⇒ PASS" or a silently-dropped check |
| DimensionResult | A dimension's roll-up — `{dimension, status, findings[]}` where **`status = PASS` iff every `Finding` is PASS; any FAIL or BLOCKED ⇒ FAIL** (`@kampus/audit-verdict` `src/schema.ts`). The dimension's headline status, **recomputed from the findings**, never trusted from a mis-set incoming headline. | a headline that can mask a failing finding |
| Verdict | The **dated, run-over-run-comparable** result `@kampus/audit-verdict` builds from the dimensions' findings — `{date, target, overall, perDimension[], findings[]}`, stable-ordered so a fixed input renders byte-identically (the precondition for mechanically diffing two dated runs). **`overall = FAIL` iff any dimension is FAIL** (recomputed from findings — story 11). Archived as a `<stamp>-<stage>.json`+`.md` pair under repo-relative `rite-audit/runs/` (`assertRepoRelative` fails loud on any leaked path). | the raw findings bundle (the explorer's output the serializer *consumes*); an ephemeral pass/fail |
| `@kampus/audit-stage` | The ephemeral **stage lifecycle** (`packages/audit-stage`, #1512): one command — **deploy → preview-seed → mint a login-able test-mod → run hook → destroy** — with **teardown guaranteed on every exit path** (`Effect.onExit`, keyed on the stage name) so a failed run never leaves a flag-on stage alive. Deploys the dedicated `audit` deploy class (force-on per #1511), never production. A pure core (`src/lifecycle.ts`) over a `StageLifecyclePort`, unit-tested against an in-memory fake. | the explorer/walk (that is the `rite-audit` skill); the verdict archive (that is `@kampus/audit-verdict`) |
| test-mod | The single **pre-existing** identity `@kampus/audit-stage` mints per run: a freshly-registered, login-able `moderator`+`yazar` that drives the **divan** vouch/promote, handed to the explorer in the run context. The **çaylak** under test is **not** seeded — each run self-registers a fresh one through the UI, exercising the real sign-up path. | the çaylak under test (self-registered each run, never seeded); a hardcoded credential (freshly minted per run) |
| `@kampus/audit-run` | The **on-demand single-entry run** (`packages/audit-run`, #1517): one command runs a whole rite-audit — provision (`@kampus/audit-stage`) → walk all dimensions → emit + archive the **Verdict** (`@kampus/audit-verdict`) → guaranteed teardown — by installing its `walk → buildVerdict → archive` body as #1512's `runHook`, reusing that teardown guarantee rather than re-deriving it. The capstone wiring of epic #1510. | a scheduled/cron run (on-demand only — scheduling is an explicit later follow-up); a re-derived teardown |
| AuditWalk / run context | The **injected walk seam** (`@kampus/audit-run` `src/run.ts`): because the explorer is an LLM driving the Playwright MCP (not a callable function), `@kampus/audit-run` is parameterized over a `walk` it **shells out** to, handing the live stage's **run context** — `AuditRunInput` `{stage, baseUrl, target, testMod}` (`@kampus/audit-stage` `src/lifecycle.ts`) — over as `$RITE_AUDIT_RUN_CONTEXT` JSON. A walk that exits non-zero, prints malformed JSON, or yields no dimensions fails loud (story 11). | a faked in-process LLM call; a hardcoded stage URL/credential (read it off the run context — a literal is stale next run) |
| audit env class / authorship-loop force-on | The rite-audit **gating prerequisite** (#1511). **`audit`** is a dedicated fourth deploy class in the `ENVIRONMENT` taxonomy (`development` / `preview` / `production` / `audit`, `apps/web/worker/environment.ts`; ADR 0088). The **force-on seam** is `AUTHORSHIP_LOOP_RULES` (`features/flagship/resources.ts`): a single environment-targeting rule serving the `phoenix-authorship-loop` flag `on` **iff** the request's `environment` attribute equals `audit` — **audit-only, prod-never** (production can never map to `audit`, so the rite is walkable only on the audit stage; the flag stays default-off everywhere else, the dark-ship safe state). | a production flag flip (`phoenix-authorship-loop` on in prod releases v1 to the public); a default-on or percentage-targeted rollout |

## Apps

| Term | Definition | Not |
|---|---|---|
| apps/web (@phoenix/web) | The ONE app/worker today — serves the SPA (via `ASSETS`) + the API. The multi-app structure (ADR 0057) exists but `web` is the sole occupant. | |
