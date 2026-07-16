# Language — the architecture vocabulary

The canonical structural vocabulary for phoenix. Use these terms exactly when you
reason or write about the shape of the code — don't substitute "component,"
"service," "API," or "boundary." Consistent language is the whole point: an audit,
a review, an ADR, and a PR description all mean the same thing by "deep module" or
"seam."

This file is **two layers**:

1. **The general architecture vocabulary** — module / interface / implementation /
   depth / seam / adapter / leverage / locality, the deletion test, and the other
   principles. Evergreen and project-agnostic; it ports the vocabulary the
   architecture-audit work is grounded in.
2. **The phoenix structural terms** — the project's own named structures (the test
   tiers, the fate loader/resolver split, the LiveDO roles), each anchored to the
   ADR that decided it. These are what the general vocabulary *names* when applied to
   this codebase.

---

## 1. The architecture vocabulary

### Terms

**Module**
Anything with an interface and an implementation. Deliberately scale-agnostic — it
applies equally to a function, a class, a package, or a tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes the type
signature, but also invariants, ordering constraints, error modes, required
configuration, and performance characteristics.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Implementation**
What's inside a module — its body of code. Distinct from **adapter**: a thing can be
a small adapter with a large implementation (a real D1-backed repository) or a large
adapter with a small implementation (an in-memory fake). Reach for "adapter" when the
seam is the topic; "implementation" otherwise.

**Depth**
Leverage at the interface — the amount of behaviour a caller (or test) can exercise
per unit of interface they have to learn. A module is **deep** when a large amount of
behaviour sits behind a small interface. A module is **shallow** when the interface is
nearly as complex as the implementation.

**Seam** _(from Michael Feathers)_
A place where you can alter behaviour without editing in that place. The *location* at
which a module's interface lives. Choosing where to put the seam is its own design
decision, distinct from what goes behind it.
_Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it
fills), not substance (what's inside).

**Leverage**
What callers get from depth: more capability per unit of interface they have to learn.
One implementation pays back across N call sites and M tests.

**Locality**
What maintainers get from depth: change, bugs, knowledge, and verification concentrate
at one place rather than spreading across callers. Fix once, fixed everywhere.

### Principles

- **Depth is a property of the interface, not the implementation.** A deep module can
  be internally composed of small, mockable, swappable parts — they just aren't part
  of the interface. A module can have **internal seams** (private to its
  implementation, used by its own tests) as well as the **external seam** at its
  interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the
  module wasn't hiding anything (it was a pass-through). If complexity reappears across
  N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you
  want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't
  introduce a seam unless something actually varies across it.

### Relationships

- A **module** has exactly one **interface** (the surface it presents to callers and
  tests).
- **Depth** is a property of a **module**, measured against its **interface**.
- A **seam** is where a **module**'s **interface** lives.
- An **adapter** sits at a **seam** and satisfies the **interface**.
- **Depth** produces **leverage** for callers and **locality** for maintainers.

### Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards
  padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**:
  too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

---

## 2. Phoenix structural terms

The general vocabulary above, applied to this codebase, names a handful of recurring
structures. Each is anchored to the ADR that decided it — read the ADR for the *why*;
this section fixes the *term* so an audit, a review, and a test file all mean the same
thing by it.

### The two test tiers (unit / integration) and seam-graduation

phoenix runs **exactly two test tiers**, split by *which fidelity a claim needs* — not
by folder. (ADR [0082](../.decisions/0082-two-test-tiers-unit-integration.md) — *Two test
tiers: unit (no DB) and integration (real D1 via alchemy `Test.make`)*, the source of
truth, extended by [0104](../.decisions/0104-two-mode-integration-test-tier.md). 0082
**supersedes** [0040](../.decisions/0040-testing-taxonomy-and-seam-graduation.md), whose
four-tier T0–T3 taxonomy rested on a faked in-memory `node:sqlite` D1 stand-in
(`makeSqliteTestDb`) and the now-falsified premise that *`node:sqlite` is the same engine
as D1*. There is **no in-memory SQL tier**; the helper is deleted.)

- **`unit` — pure logic + in-process service contracts, no database.** Pure functions /
  Effect logic and feature-service contracts that are wrong-or-right *even if the DB
  behaves perfectly* (normalization, clamping, envelope shaping, pagination math, auth
  gates, empty/cursor-miss branches, topic-key routing). No deployed worker and **no SQL
  engine** — the `Drizzle` storage seam is *substituted* (a `run`/`batch` that throws or a
  stubbed return proves the decision never touched the DB). Runs offline in the default node
  pool; files carry the `*.unit.test.ts` infix (plus plain `*.test.ts` service-contract
  tests). Examples: a keyset codec, the pasaport `me` auth gate, `Bookmark.unit.test.ts`.
- **`integration` — real behavior over real remote Cloudflare D1.** Black-box over the
  deployed phoenix stack via the alchemy `Test.make` idiom: a file runs against a real
  worker + D1 (+ DOs) and asserts over HTTP/SSE. This is the only tier that can prove a
  claim that *could only be wrong if the real engine differed* — D1's FTS5 build,
  tokenizer, and collation are **not** `node:sqlite`'s, so search/ranking fidelity,
  `ON CONFLICT`/soft-delete round-trips against real rows, and the DO + SSE + D1 composite
  all land here. Per ADR 0104 the tier runs in two modes: a run-scoped shared stage for the
  pure-logic-dominant files and per-file dedicated stages for the few that need isolation
  (`tests/integration/_integration.ts`). Examples: `search.test.ts`, `fate-live-posts.test.ts`.

**One `Database` seam.** A single `Database` tag holds the raw `D1Database` handle; both
the `Drizzle` service and the better-auth adapter *derive* from it, so they share one
underlying handle by construction — the one-handle invariant is type-enforced by the layer
graph, not upheld by hand. At `unit` that seam is *substituted*; the real handle exists only
at `integration`, where it is real remote D1.

**Seam-graduation (organic framework evolution).** A test seam is born app-local and
graduates only when it has earned it:

- **Gate A — rule-of-three → extract an app-local factory.** At ≥ 3 in-app call sites,
  extract a *factory* (fresh per call; never a shared mock-layer instance). Its home
  stays app-local under `worker/`, not `packages/`.
- **Gate B — graduate to a package / upstream.** Requires proven-in-app **and** a second
  consumer or an upstream home. An empty `packages/` is load-bearing signal that nothing
  has earned graduation.

### The fate loader/resolver split

In phoenix's fate data layer, **sources LOAD; operations RESOLVE.** The split is a seam,
and the two sides have fixed interfaces. (ADR
[0016](../.decisions/0016-fate-pure-transport-effect-services-domain.md) —
*fate is pure transport, Effect services are the domain*; the loader contract is the
[fate-effect sources pattern](../.patterns/fate-effect-sources.md).)

- **Loader (a source).** `Fate.source(View, {id}, handlers)` declares the per-entity
  loader: at least one of `byId` / `byIds`, **silent reads** (a missing id returns
  `null` / a short list, not a failure), and a failure channel pinned to `never`
  (infrastructure failures die one layer down, inside the domain service). `byIds` is the
  workhorse that kills N+1 under the interpreter's `RequestResolver` batching, and it must
  be **membership-stable** — its rows must be a function of the id *set* (every SQL
  `IN`-shaped loader qualifies); a cursor-limited or order-sensitive `byIds` silently
  diverges under a merged batch window.
- **Resolver (an operation / custom query).** What runs the read-or-write, masks the
  resolved fields down to what the view permits, and translates failures to wire codes at
  the boundary. Connections are resolvers, not loader handlers: a source carries **no
  `connection` handler** — keyset `ORDER BY` lives in the domain service, surfaced by a
  custom resolver in `queries.ts` / `lists.ts`.

The seam matters because the two sides cross **different** trust boundaries: the loader is
pure-membership and batch-mergeable, the resolver is where authorization-masking and
error-translation happen. fate itself never queries the database — handlers delegate to
the domain services.

### Branded ID schema

A **branded ID schema** is an entity id typed as a nominal brand over a plain string —
`Schema.String.pipe(Schema.brand("Name"))`, output type `Brand.Branded<string, "Name">` —
so two ids that are both `string` at runtime (a user id, a definition id) become **distinct
types** the checker won't let you pass for one another. The brand is **compile-time only**:
it narrows the output type without validating, so `.make`/decode return the input unchanged
and the wire + D1 bytes stay byte-identical — no runtime allocation, no runtime check. (Epic
[#2700](https://github.com/kamp-us/phoenix/issues/2700); idiom grounded in effect-smol
`SCHEMA.md` §Branding — the top-level `Schema.brand` form, not a hand-rolled phantom symbol.)

- **The shared home + the mint.** All branded ids live in one module,
  [`apps/web/worker/lib/ids.ts`](../apps/web/worker/lib/ids.ts), and are minted by its
  `brandedId(name)` helper (`export const UserId = brandedId("UserId")`). A write boundary
  brands a raw session string at the call site with `.make` — e.g. `UserId.make(user.id)` in
  [`features/sozluk/mutations.ts`](../apps/web/worker/features/sozluk/mutations.ts).
- **Shared cross-feature vs. feature-owned.** `UserId` is the **cross-feature** id — the
  authenticated user threaded as every write's actor/author/voter/reactor argument. A
  **feature-owned** id belongs to one product surface: sözlük's `DefinitionId` / `TermSlug`.
  Feature-owned ids co-locate in `lib/ids.ts` beside `UserId` (one import for every child of
  #2700), but stay conceptually owned by their feature — a `PostId` (pano) is declared with
  its own surface, not reused across features. Distinct brands are what make an argument swap
  like `voteDefinition({definitionId, voterId})` a typecheck error instead of a live bug.

### Store of record vs. data view — "view" names the fate read-shape only

Two unrelated module kinds in the same feature folder once both wore the word "view"; the
vocabulary now keeps them apart.

- **Store of record (`*_record` Drizzle table).** The authoritative, **mutated** D1 table
  add/edit/remove write directly to under the D1-direct model (ADR
  [0009](../.decisions/0009-d1-direct-defer-dos-and-workflows.md) — there is no projection layer).
  `definition_record` / `comment_record` (Drizzle `definitionRecord` / `commentRecord`) are
  the canonical stores whose loss *is* data loss. The `_record` suffix is load-bearing: it
  reads as "store of record" and reserves "view" for the data view below. They were renamed
  off the projection-era `*_view` name in #853 — that name lied about the module kind (a
  reader assumes a rebuildable read-projection) and collided one capital apart with the fate
  data view.
- **Data view (fate `FateDataView`).** A pure read-shape *declaration* — the fields a fate
  entity exposes, not a table. `DefinitionView` / `CommentView` (PascalCase, in each
  feature's `views.ts`) declare what the loader/resolver above project; they hold no rows and
  are never written. See the "data view" row in [`TERMS.md`](./TERMS.md).

The test: if you can `INSERT`/`UPDATE` it, it's a store of record; if it only *declares
fields to read*, it's a data view (`*View`). Never name a write target a "view." The
`*_record` suffix is narrower than "any store of record": it marks a store that is
**shared across packages** (the canonical `@kampus/db-schema` declaration). A worker-private
mutated store — `user_profile`, `content_report`, the stats singletons — is a store of record
too, but lives in the worker schema without the suffix, so lacking `*_record` is not a
convention violation for those.

### The LiveDO connection / topic roles

Cross-isolate live (SSE) fan-out is carried by **one** `LiveDO` Durable Object class that
plays **two roles**, selected by instance-name prefix. (ADRs
[0023](../.decisions/0023-live-views-sse-livedo.md) — live views over SSE, the original
fan-out; [0025](../.decisions/0025-split-livedo-connection-topic.md) — the connection/topic
split, now superseded; [0028](../.decisions/0028-effect-durable-object-model.md) — the
Effect DO model the roles are authored on; [0037](../.decisions/0037-unified-void-aligned-live-do.md)
— the **current** state: one void-aligned class, two roles, KV storage.)

- **Connection role** (`connection:<id>`). Owns **one client's** held SSE stream, its
  subscription list, and its persisted `generation` (the stale-detection counter). It is
  the per-client endpoint of the fan-out.
- **Topic role** (`topic:<key>`). Owns the **durable subscriber registry** for one topic,
  the publish fan-out to that topic's connections, and the reap of dead connections. It is
  the per-topic hub.

A publish-only `LiveEventBus` forwards `live.*` events to the topic role, which delivers
to the connection role. The two roles **share no runtime state** — an instance is always
exactly one role. The history is worth knowing: ADR 0023 packaged both roles in one class;
0025 split them into separate `ConnectionDO` / `TopicDO` classes to make invalid cross-role
calls *unrepresentable*; 0037 reunified them into a single class (the split's two
motivations — a mutual-DO Layer cycle and a SQLite registry — both went away), where a
misroute now no-ops at runtime (role-guarded) rather than failing to compile.

### The composition shell / recipe

A **shell** wraps a nav/page **primitive** and owns a whole zone, exposing it to the page
as **flat element-props — one `ReactNode` prop per zone** — so an element not assigned to a
declared zone is a *type* error, not a lint finding. The **recipe** is the composition idiom
a shell is built on. (ADR
[0182](../.decisions/0182-subnavshell-pageshell-composition-api.md) — *SubnavShell / PageShell
composition API — flat element-props*, which coins both terms; it builds on ADR
[0176](../.decisions/0176-nav-ia-discipline.md)'s nav element taxonomy. The `SubnavShell` /
`PageShell` source is defined by that ADR — the term is grounded in the ADR until the shells
land in [`apps/web/src/components/layout/`](../apps/web/src/components/layout/).)

- **`recipe`** — the composition-primitive idiom: **one flat element-prop per zone**,
  orphan-as-type-error. NOT a zones-object, NOT compound components
  (`<Shell.Destinations>…`) — a compound API leaves an *orphan slot* (an element rendered
  but placed nowhere) that only a lint pass catches; flat element-props make that
  unrepresentable, because an element with no declared zone prop has nowhere to compile in.
- **`shell`** — the layout-composition wrapper (`SubnavShell` / `PageShell`) that **names a
  page's zone-plus-content shape once** and hands each zone to the consumer as one prop.
  `SubnavShell` composes the per-product [`Subnav`](../apps/web/src/components/layout/Subnav.tsx)
  primitive (wrapping it, not replacing it); `PageShell` composes `SubnavShell` plus the routed
  page content below it. A shell sits *between* a **primitive** and the page — distinct from a
  **primitive**, which owns no zone and exposes raw slots.

### The three senses of "phoenix"

"phoenix" carries **three distinct meanings**, each with a graduation name —
disambiguate which one a doc means, because they're about to fork harder (`phoenix-ops`
leans on sense 3, product milestones lean on sense 2):

1. **phoenix, the monorepo** — this repository: the multi-app, multi-worker Cloudflare
   workspace (`apps/*`, `packages/*`, `infra/*`). Product/company side — the ground the
   other two stand on.
2. **phoenix, the product codename** — kamp.us vNext, the reborn community, under its
   build-time codename. Product/company side. When it ships it simply becomes **kamp.us**
   — the codename is retired, not renamed; the product comes home to its own name.
3. **phoenix, the framework** — the batteries-included application framework the other two
   are quarried from: alchemy + Effect + fate, battle-tested in production, general-purpose,
   future-facing. Not a kamp.us artifact — a standalone one forged here, built for keeps. It
   graduates to **anka** — the Turkish phoenix (*Anka kuşu / Zümrüdüanka*) — as its permanent
   name.

Monorepo + product-codename are **product/company** side; the framework is the **durable,
reusable** side.

The through-line worth preserving: **the framework is the true phoenix** — the part built to
outlive its origin — so it earns the Turkish phoenix name **anka** and rises to live
independently; the product simply comes home to **kamp.us**. Rebirth named in English
(*phoenix*), completed in Turkish (*anka*), landing on the repo's Turkish-for-brand /
English-for-technical rule (§3). `anka` is a **framework name**, not user-facing product
copy, so it lives here in sense (3) rather than as a §3 Turkish-surface brand-noun row.

### Milestone

**A milestone is an *initiative*. An initiative has a Definition of Done.** A catch-all with
no DoD is a **label, not a milestone**. A fixes-bucket like "Sözlük/Pano fixes" is an
*oxymoron* to this definition — it has no DoD, so it can't be an initiative, so it isn't a
milestone; its disposition is to **retire** (convert to a plain label if the grouping is
still wanted), not "close as done." (ADR
[0072](../.decisions/0072-milestones-encode-strategic-sequencing.md) — *milestones encode
strategic sequencing*.)

A **standing cross-cutting axis** — a perpetual concern with no terminal DoD (token
efficiency, test/CI health, pipeline hardening) — is likewise **a label, not a milestone**,
by the same DoD test. Its label is `axis:*`, distinct from `area:*`: **`area:*` = product
area, `axis:*` = cross-cutting concern** (e.g. `axis:token-efficiency`, `axis:test-ci-health`,
`axis:pipeline-hardening` vs `area:sozluk-pano-ui`). Tag **go-forward only** — open issues get
the axis label; closed issues are not retro-tagged (the `area:sozluk-pano-ui` precedent).

An `axis:*` label **does not anchor p1** — only a **live fire** or an **active bounded
milestone** does. A standing axis is **p2-by-default**; an individual item rises to p1 only
when it is a genuine fire (a broken gate, a false-verdict trust bug). This keeps a lane's
sustained importance out of the priority spine, so it can't rebuild the p1-inflation backdoor
the milestone-relative p1 rule closed (#1936 / #2078). *Founder-override-open* — the founder
may later designate an `axis:*` (e.g. `axis:pipeline-hardening`) a p1-anchor; until relayed,
this rule stands. (Extends the #2093 → #2095 milestone-governance convention.)

---

## 3. Product / brand nouns (Turkish surface)

The naming convention is **Turkish for product / brand, English for technical**:
product and brand names and all user-facing copy stay Turkish; everything technical is
English — URL routes/paths, code identifiers, D1 table/column names, file names. The
canonical example is that the route is `/search?q=`, not `/ara`.

**Two axes hide inside this one rule — keep them separate.** *Canonical glossary-term
language* (the name a concept carries in [`TERMS.md`](./TERMS.md)) and *UI copy language*
(the strings rendered on a user's/mod's screen) are decided **independently**:

- A **technical / analytics / infra concept keeps an English canonical term**, even when
  the concept appears on a Turkish-speaking user's or mod's screen. A *conversion funnel*
  is recorded as `funnel / conversion funnel`, never force-translated into a manufactured
  "dönüşüm hunisi" (an ugly, needless translation of a technical concept). This holds
  when the [ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)
  glossary-freshness gate demands a term for a new internal/analytics surface: **coin the
  English term, don't translate it** — the concept stays English regardless of what
  language its page renders in.
- **User-facing UI copy stays Turkish** — the existing rule, unchanged. The mod-facing
  funnel page renders Turkish copy while the concept underneath keeps its English
  canonical name.

The `bildir` row below already models this split: the brand lexeme surfaces in the
user-facing copy (`bildir` / `bildirildi`) while its technical surface (`features/report`,
the `Report` service, `content_report`) stays English. The funnel is the mirror case —
a technical concept whose *canonical term* is English (`funnel / conversion funnel`) even
though the surface it powers renders Turkish UI copy. Collapsing the two axes ("the
concept shows on a Turkish screen, so its glossary term must be Turkish") is the mistake
this note exists to stop.

The Turkish product/brand nouns this repo uses:

| Noun | What it names |
|---|---|
| **sözlük** | the dictionary product (terms + definitions) |
| **pano** | the link/discussion board product (posts + comments) |
| **kampus** | the umbrella product / community |
| **bildir** | the report / notify surface — the brand lexeme surfaces in the **user-facing copy** (the `ReportButton` labels `bildir` / `bildirildi` / `zaten bildirildi`); the technical surface (`features/report` dir, `Report` service, `content_report` table) is English per this convention |
| **künye** | the per-user identity DO (karma, invite-only access, privileges) |
| **depo** | the internal asset store/CDN (was imge) |
| **divan** | the proving-ground reviewer surface — the gated `/divan` destination where yazar + moderatör review a çaylak's sandboxed work ("work goes before the divan") |
| **mecmua** | the serious long-form blogging / publishing product (a third surface beside **sözlük** + **pano**, epic #2429) — a **yazar** authors and publishes a long-form post (başlık + markdown body) that anyone may read; a **çaylak** cannot publish (authorship is earned). v1 is a surface on the existing `apps/web` worker, not its own app. Turkish for "magazine / journal / anthology" |
| **sustur** | mute — the **one-directional, silent, notification-suppressing** member-mute lever (epic #2571; v1 semantics fixed by ADR [0188](../.decisions/0188-mute-v1-semantics.md)). Muting a member both read-masks their content *and* suppresses the **bildirim** their interactions would generate to the muter; the muted member is never notified. Distinct from **engelle** (block) — mute is one-directional and lighter. Turkish for "silence / mute" |
| **engelle** | block — the heavier, **mutual** interaction-prevention lever (preventing replies/mentions/mutual visibility, symmetry TBD). **Deferred from mute v1** and scoped to its own later decision/epic (ADR [0188](../.decisions/0188-mute-v1-semantics.md)); named here to keep it distinct from the lighter one-directional **sustur** (mute). Turkish for "block / obstruct" |

> This is the brand-noun seed. The full domain-noun glossary (the entities and their
> precise definitions) lives in its own `.glossary/TERMS.md`; this table fixes only the
> product/brand spellings and the Turkish-vs-English rule so they aren't duplicated in
> `CLAUDE.md`.

---

## See also

- [`.decisions/`](../.decisions/) — the *why* and the history behind every term
  here (an ADR is the source for each phoenix structural term).
- [`.patterns/`](../.patterns/index.md) — how the current code is shaped (the loader
  contract, the test seams, the DO wiring).
- [`CLAUDE.md`](../CLAUDE.md) — points here for the canonical vocabulary.
