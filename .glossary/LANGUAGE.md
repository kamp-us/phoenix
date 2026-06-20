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

### The test tiers (T0–T3) and seam-graduation

phoenix names its test tiers by **which layer satisfies a fixed dependency channel**,
not by folder. A tier is a choice of adapter at the storage **seam**; the tier boundary
is where the layer algebra runs out — the workerd process boundary. (ADR
[0040](../.decisions/0040-testing-taxonomy-and-seam-graduation.md) — *Testing taxonomy
and test-seam graduation*, the source of the tier vocabulary. Note: 0040 is **superseded
by [0082](../.decisions/0082-two-test-tiers-unit-integration.md)**, which collapses the
day-to-day naming to two tiers, **unit** and **integration**; the T0–T3 vocabulary below
is the full taxonomy 0040 fixed and the terms an audit still reaches for.)

- **T0 — unit (pure).** Pure functions / Effect logic, zero storage. The seam is never
  crossed; there is no SQL engine and no I/O. _If a test boots `node:sqlite` it is not a
  T0 unit test._ Examples: a keyset codec, hot-score arithmetic, `encodeFateError`.
- **T1 — service-integration.** A real feature service over a real in-memory SQL engine
  (`node:sqlite` behind the D1 surface) + real migrations, in one Node process. Only the
  `Database` layer swaps at the seam. Examples: `Vote.test.ts`, `Drizzle.test.ts`.
- **T2 — bridge / app-integration.** The full request env (minus the per-request trio)
  driven through `fateServer.handleRequest`: wire codes, topic publishes,
  real-or-stubbed auth. Still `node:sqlite` under the worker layer, no workerd. Examples:
  `sozluk.test.ts`, `products.test.ts`, `app.test.ts`. T1 and T2 stay distinct because
  they swap *different* layers — T1 only the `Database` seam, T2 also the wire-encoding
  boundary and the auth layer.
- **T3 — system (stack-smoke, NOT a layer).** Black-box HTTP over the deployed alchemy
  stack on local workerd, asserted against **real remote D1**. There is no dependency
  channel to provide to — it's a URL, not a layer. Reserved for the genuine real-D1-only
  divergences (batch-meta envelope, `foreign_keys` default, the DO + SSE + D1 composite).
  Examples: `seam.test.ts`, `fate-live.test.ts`.

**One `Database` seam.** A single `Database` tag holds the raw `D1Database` handle; both
the `Drizzle` service and the better-auth adapter *derive* from it, so they share one
underlying handle by construction — the one-`sqlite` invariant is type-enforced by the
layer graph, not upheld by hand. Domain correctness (keyset order, `ON CONFLICT`,
soft-delete filters) is **hermetically faithful at T1/T2** because `node:sqlite` is the
same engine as D1, so it belongs there, not at T3.

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

---

## 3. Product / brand nouns (Turkish surface)

The naming convention is **Turkish for product / brand, English for technical**:
product and brand names and all user-facing copy stay Turkish; everything technical is
English — URL routes/paths, code identifiers, D1 table/column names, file names. The
canonical example is that the route is `/search?q=`, not `/ara`.

The Turkish product/brand nouns this repo uses:

| Noun | What it names |
|---|---|
| **sözlük** | the dictionary product (terms + definitions) |
| **pano** | the link/discussion board product (posts + comments) |
| **kampus** | the umbrella product / community |
| **bildir** | the report / notify surface |
| **künye** | the per-user identity DO (karma, invite-only access, privileges) |
| **imge** | the image surface |

> This is the brand-noun seed. The full domain-noun glossary (the entities and their
> precise definitions) lives in its own `.glossary/TERMS.md`; this table fixes only the
> product/brand spellings and the Turkish-vs-English rule so they aren't duplicated in
> `CLAUDE.md`.

---

## See also

- [`.decisions/`](../.decisions/index.md) — the *why* and the history behind every term
  here (an ADR is the source for each phoenix structural term).
- [`.patterns/`](../.patterns/index.md) — how the current code is shaped (the loader
  contract, the test seams, the DO wiring).
- [`CLAUDE.md`](../CLAUDE.md) — points here for the canonical vocabulary.
