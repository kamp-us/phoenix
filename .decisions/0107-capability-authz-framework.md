---
id: 0107
title: Capability-as-Effect authorization framework (packages/authz + künye)
status: accepted
date: 2026-06-26
tags: [authz, platform, effect, kunye]
---

# 0107 — Capability-as-Effect authorization framework

## Context

kamp.us is a human-AND-agent commons with an earned-authorship ladder, and it is
**many products under one identity** (sözlük, pano today; topluluk communities on the
horizon). It needs an authorization model that (a) makes "forgot to check" a compile
error, (b) grows by *adding modules* rather than editing a central file (the
agent-autonomous-growth north star, discussion #1194), and (c) does not overfit to v1's
two authority kinds while also not building an OpenFGA-class engine for uses that don't
exist.

Three prior threads converge here and are resolved by this decision:

- **ADR [0098](0098-moderation-role-resolution-lifecycle.md)** placed moderation behind a
  `Moderator.required` capability reading the `user.role` column. This ADR supersedes its
  *role/Moderator-capability* mechanism (the invisible-denial / fresh-read / fail-closed
  *invariants* are preserved and carried forward).
- The admin cluster (#873/#966/#967/#972) planned to adopt **better-auth's AC model** as
  the platform authz substrate. **Rejected.** better-auth is **authn only** (sessions,
  apiKeys, the admin *user-management UI*); all authorization is this framework. This is
  the answer to the open #966 "admin role taxonomy" ADR: **admin is one relation-backed
  capability instance**, not a second authz system.
- The künye milestone (#41 et al.) framed künye as a reputation DO. This ADR fixes künye's
  role precisely: **pasaport = authn/identity; künye = authz/earned-standing; `packages/authz`
  = the vocab-free mechanism.**

Grounded throughout in effect-smol's canonical authz idiom (the `HttpApiMiddleware`
`Authorization` fixture: check → provide a typed proof into context) and reviewed against
effect-smol v4 source.

## Decision

Build a **vocab-free authorization framework** in `packages/authz/` and the kamp.us
**instances + standing** in `apps/web/worker/features/kunye/`.

**1. Enforcement = capability-as-Effect.** A privileged op requires an unforgeable proof,
`Grant`. The only way to obtain one is to discharge a check (an Effect that fails typed).
`Grant` is sealed: a class whose **constructor is never exported** (only the *type* escapes
the module) and is **not a Schema** (a decodable proof would be forgeable). The proof flows
through the **context (R) channel** via `.pipe(Cap.provide(grant))` — never as a field on the
op's domain input — mirroring the effect-smol fixture's `provideService`. An op declares the
proof in its R-channel; omitting `.provide` is a **compile error** at layer composition.

**2. Capability-per-right — the tag IS the right.** Capabilities are named by *what they
authorize* (`OpenTerm`, `AddEntry`, `Moderate`, `Admin`), not by a level compared at the
callsite. The `Grant` carries the actor and the scope proved, but **not a level**; a
çaylak-level proof and a yazar-level proof of *different rights* are different types, so the
wrong proof does not typecheck. (A *dynamic, per-object* threshold — the MLS clearance shape —
is the one case a proof carries its level; it is not in v1.)

**3. Class-as-capability — one declaration.** A capability is a single class extending a
builder, mirroring `HttpApiMiddleware.Service`: `class OpenTerm extends
Capability.Level<OpenTerm>()("kunye/OpenTerm", {scale, min, read, deny}) {}`. The class *is*
the proof tag, the `Grant` type, the discharge verb (`.require` for `Level`, `.over(resource)`
for `Relation`, `.authorize(check)` for the generic `Class`), and `.provide` — all from one
name. No empty tag + adjacent factory const that can drift. `Capability.Class` is the base
class-builder (the effect `Data.Class`/`Schema.Class` grain); `Level` and `Relation` are its
named specializations.

**4. Two axes, deliberately asymmetric.**
- **`Level`** (RBAC/MLS-shaped, ordered) backs the **earned authorship ladder** — `visitor <
  çaylak < yazar`. It is a **GLOBAL account-level standing**, read from künye, shared across all
  kamp.us products and **never re-earned** (re-grinding a rank in another product is a
  leave-immediately UX failure — the load-bearing product law). The ordering lives inside each
  right's check (`gte`), so a yazar passes any çaylak-floored gate.
- **`Relation`** (ReBAC) backs **assigned, resource-scoped authority** — `moderates`, `admin`.
  Per-product / per-community variation lives entirely on this axis.

**5. Ports/adapters layering.** `packages/authz` declares ports (`CurrentActor`,
`RelationStore`, `AgentAuthority`) as `Context.Service`s and names no kamp.us noun, no fate,
no D1. `features/kunye/` provides the adapter Layers (`CurrentActor` ← pasaport session;
`RelationStore` ← D1 tuples; `Kunye` ← standing store) and owns the wire-coded errors
(`Denied`/UNAUTHORIZED for invisible moderation denial; `RequiresLevel`/FORBIDDEN for the
public ladder).

**6. Agents seamed, dormant (v1 humans-only).** `Actor = Unauthenticated | Authenticated
(Human | Agent)`. Agent attenuation (an agent's authority ⊆ its human root) is a
**read/combine seam**: the capability factories *read* own/root standing and hand plain values
to the `AgentAuthority` port, which *combines* them. v1's `AgentAuthorityV1` Layer is
fail-closed; **v1.1 swaps that one Layer** for the real policy with **no edit to
`packages/authz`**. This is the framework's completeness litmus: v1.1 must be additive.

**7. Implementation prerequisite.** `packages/fate-effect` gains a **generic per-request
middleware provision seam** so the app can provide `CurrentActor` per request (derived from the
existing `CurrentUser`) without coupling fate-effect to authz. This is the same middleware idiom
adopted above, at the transport layer.

## Consequences

**Easier.** Adding an authority model (a new right, a new relation, a per-community role,
admin) is an additive module — a class declaration against stable primitives, **never a
central-file edit**. "Forgot to authorize" and "used the wrong right's proof" become compile
errors. Moderation and authorship become symmetric instances of one mechanism. The agent
future (v1.1) is a Layer swap. topluluk (per-community ladders + Discord-style roles) composes
the same primitives.

**Harder / banned.** No central PDP; a stringly `decide(action: string)` / `check(rel: string)`
public boundary is banned (erases types + the error channel). `user.role` is **retired as an
authority source** — moderation moves to a `moderates` tuple store (founders offline-seeded);
the column may remain only as a vestigial display flag. better-auth's AC model is **not** used
for authorization.

**Explicitly out of scope (reachable, deliberately deferred).**
- **Agents** — seamed but dormant in v1 (humans-only); v1.1 is the `AgentAuthority` Layer + the
  agent-keyed resolver branch.
- **topluluk** (per-community ladders + roles) — additive on the same primitives; not v1.
- **Nested platforms** (recursive product suites per org — the enterprise lane) — reachable on
  the recursive `Resource` primitive, but it converts the shallow-static authority tree into a
  **deep-dynamic** one, which is the documented **OpenFGA/SpiceDB buy-trigger**. Designed-for
  additively, **not built**; the build-vs-buy substrate call happens when a real org grounds it.
- **MLS dynamic-threshold capabilities** (per-object varying clearance, proof carries its level)
  — a known additive capability shape, used only where a product genuinely needs it.

**Migration.** A `relation_tuple` (subject, relation, object) D1 table + an offline seed minting
the ~20 founders as `(id, "moderates", "platform")`. The current `report/Moderator.ts` rewrites
to a `Capability.Relation` instance; `report.resolve` threads the `Grant` proof.

**Process.** Conversation-authored platform ADR (the ADR [0075](0075-conversation-authored-adr-exception.md)
issueless exception). The sözlük **term/entry** domain split used in examples here is a separate
sözlük-domain decision (informs #1203), not part of this framework decision.
