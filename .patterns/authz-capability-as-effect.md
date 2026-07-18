# Capability-as-Effect authorization

How a privileged op is gated in phoenix: it **requires an unforgeable proof in its
Effect requirements (R) channel**, and the only way to obtain one is to discharge a real
check. "Forgot to authorize" is therefore a **compile error**, not a runtime hole. The
mechanism is the vocab-free `@kampus/authz` package ([ADR
0107](../.decisions/0107-capability-authz-framework.md)); the kamp.us capability instances
live in `apps/web/worker/features/kunye/`, never in the package.

Read [effect-context-service.md](./effect-context-service.md) first — a capability *is* a
v4 `Context.Service` class, so the service-class rules there all apply here.

## The shape: builder → discharge verb → sealed `Grant` → `Grant.provide`

One class declaration is the whole capability. Extending a builder yields, from a single
name, the proof **tag**, the `Grant` type it proves, and the **discharge verb**. Discharge
into an op's R channel is the **one canonical `Grant.provide(grant)`** — generic over every
capability, not a per-class member (collapsed in #1270):

```ts
// in features/kunye — the instance names the kamp.us noun + wire error
class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale, // Scale(["visitor", "çaylak", "yazar"])
	min: "yazar",
	read, // (principal) => Effect<rank> — reads künye standing
	deny, // () => RequiresLevel — the wire-coded error
}) {}

// 1. discharge a check → an unforgeable proof, or a typed denial in E
const grant = yield* OpenTerm.require;

// 2. a privileged op declares the proof in its R channel
const openTerm: Effect.Effect<Term, never, OpenTerm> = Effect.gen(function* () {
	const proof = yield* OpenTerm; // reading the proof is the gate
	// …
});

// 3. `Grant.provide` discharges it — and ONLY this collapses R to `never`.
//    It reads the capability Key the grant carries, so one verb fits every right.
openTerm.pipe(Grant.provide(grant)); // R: never
```

Three builders, the deliberately asymmetric axes of ADR 0107 §4:

| Builder | Discharge verb | Axis |
| --- | --- | --- |
| `Capability.Class<Self>()(id, {deny})` | `.authorize(check)` | generic — a caller-supplied boolean `Effect` |
| `Capability.Level<Self>()(id, {scale, min, read, deny})` | `.require` | ordered ladder (RBAC/MLS) — reads standing, mints when it `gte` the floor |
| `Capability.Relation<Self>()(id, {relation, deny})` | `.over(resource)` | ReBAC — mints when the actor holds `relation` over the resource's ancestry |

The two specializations dispatch **exhaustively on the `Actor`** (`Unauthenticated` denies,
`Human` checks directly, `Agent` reads its human root's standing and consults the
`AgentAuthority` port — the dormant v1 seam, fail-closed). The mechanism names no wire
code: every denial is the instance-supplied `deny()` thunk.

## The two properties that make it sound

The full soundness argument — and why each alternative fails — is [ADR
0107](../.decisions/0107-capability-authz-framework.md) §4; the two load-bearing guarantees:

**1. Forgot-to-check is a compile error.** The proof rides the **context channel**, never a field
on the op's domain input, so an op that declares the capability in its R **cannot reach `R =
never`** (the only runnable shape) without `Grant.provide(grant)`, whose only source is that
capability's discharge verb. `Grant.provide` is generic: it reads the capability `Context.Key` the
grant carries (stamped non-enumerably at `mint`) and removes only that `C` from R, so a grant for
capability X discharges only X and a wrong-capability grant leaves the requirement unsatisfied. Two
capabilities are nominally distinct — the sealed `CapabilityTag<Self, Id>` carries each `id` string
literal — so `Grant<X>` ≢ `Grant<Y>` at compile time too. `Capability.typetest.ts` pins both as R-channel
assertions (forgot-to-provide, wrong-proof).

**2. `Grant` is sealed two ways** (`Grant.ts`):
- **Its constructor never escapes** — the `Grant` type, `Grant.provide`, and `isGrant` are on the
  barrel; `mint` is package-internal. A consumer can hold and discharge a proof but cannot
  fabricate one.
- **It is not a `Schema`** — a decodable proof would be forgeable. It is a plain object branded by
  an unexported `unique symbol`, phantom-keyed by the capability tag, so a proof of one right is
  the wrong *type* for another.

## The one audited cast: `sealCapability`

The internal builder hits a real effect-smol typing limit, handled with **exactly one** coercion
(`Capability.ts`, `sealCapability = <T>(tag: unknown): T => tag as T`) — a single cast across an
`unknown` boundary (the [`no-type-assertions`](./biome-custom-gritql-rules.md) plugin's permitted
single-cast form, **not** `as any`). It exists because a bare `Context.Service` class rejects the
structural match to the augmented `Capability*` type; effect-smol's own `HttpApiMiddleware.Service`
resorts to `as any` for the identical reason, and this cast is the tighter, sound form. Each
internal builder names itself as its Service `Self` (the `classSelfMismatch` convention); the
external `Self`-parameterized public type is produced by the cast.

The cast lives at exactly one seam, pinned by `Capability.typetest.ts` + the unit tests — never
sprinkle `as` casts to route around a builder typing wrinkle; extend `sealCapability` or the public
`Capability*` types instead.

## Ports / adapters — the package names no kamp.us noun

`@kampus/authz` declares `CurrentActor`, `RelationStore`, and `AgentAuthority` as
`Context.Service` **ports** and knows nothing of fate, D1, or any product noun.
`features/kunye/` provides the adapter Layers (`CurrentActor` ← pasaport session;
`RelationStore` ← D1 tuples; standing ← künye) and owns the wire-coded errors. Adding an
authority model — a new right, a relation, a per-community role, admin — is an **additive
class declaration** against these stable primitives, never a central-file edit (the
agent-autonomous-growth north star). v1 is humans-only; v1.1 is a single `AgentAuthority`
Layer swap with no edit to the package.
