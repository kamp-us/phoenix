# Capability-as-Effect authorization

How a privileged op is gated in phoenix: it **requires an unforgeable proof in its
Effect requirements (R) channel**, and the only way to obtain one is to discharge a real
check. "Forgot to authorize" is therefore a **compile error**, not a runtime hole. The
mechanism is the vocab-free `@kampus/authz` package ([ADR
0107](../.decisions/0107-capability-authz-framework.md)); the kamp.us capability instances
live in `apps/web/worker/features/kunye/`, never in the package.

Read [effect-context-service.md](./effect-context-service.md) first — a capability *is* a
v4 `Context.Service` class, so the service-class rules there all apply here.

## The shape: builder → discharge verb → sealed `Grant` → `.provide`

One class declaration is the whole capability. Extending a builder yields, from a single
name, the proof **tag**, the `Grant` type it proves, the **discharge verb**, and
**`.provide`**:

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

// 3. `.provide` discharges it — and ONLY this collapses R to `never`
openTerm.pipe(OpenTerm.provide(grant)); // R: never
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

**1. Forgot-to-check is a compile error.** The proof rides the **context channel**, never a
field on the op's domain input. An op that declares the capability in its R **cannot reach
`R = never`** (the only shape a runnable program has) without `.provide(grant)`, and the
only source of a `Grant<Cap>` is that capability's discharge verb. This is the
`provideService` idiom of effect-smol's `HttpApiMiddleware` Authorization fixture (check →
provide a typed proof). The guarantee is pinned by `Capability.typetest.ts`, which asserts
the **R channel** with `expectTypeOf`: omit `.provide` and the capability stays required in
R; provide it and R collapses to `never`. (It reads the channel rather than asserting an
assignment — assigning a service-requiring effect to an `R = never` annotation trips the
language-service's `effect(missingEffectContext)` diagnostic, which `@ts-expect-error`
does not catch.)

**2. `Grant` is sealed two ways** (`Grant.ts`):
- **Its constructor never escapes** — only the `Grant` *type* and `isGrant` are on the
  barrel; `mint` is package-internal. A consumer can hold and pass a proof but cannot
  fabricate one.
- **It is not a `Schema`** — a decodable proof would be forgeable (decode a crafted payload
  → a valid-looking proof). It is a plain object branded by an unexported `unique symbol`;
  no external value inhabits `Grant<M>`. The brand is phantom-keyed by the capability tag,
  so a proof of one right does not satisfy another — the wrong right's proof is the wrong
  *type*.

## The one audited cast: `sealCapability`

The internal builder hits a real effect-smol typing limit, handled with **exactly one**
coercion (`Capability.ts`, `sealCapability = <T>(tag: unknown): T => tag as T`), a single
cast across an `unknown` boundary (the [`no-type-assertions`](./biome-custom-gritql-rules.md)
plugin's permitted single-cast form, **not** `as any`):

- A bare `Context.Service` class pins its `[Unify.unifySymbol]` to its *un-augmented*
  self-type, so TS rejects the structural match to the augmented `Capability*`-family type
  (the `.provide` + discharge verb), and inferring `typeof Tag` leaks effect-internal
  symbols past nameability. effect-smol's own `HttpApiMiddleware.Service` resorts to `as any`
  for the identical reason; this cast is the tighter, sound form.
- Each internal builder class **names itself as its Service `Self`** —
  `class Tag extends Context.Service<Tag, Grant<Self>>` — the canonical effect-class
  convention the `@effect/language-service` `classSelfMismatch` rule enforces (run as an
  error by `@effect/tsgo`). The *external* `Self`-parameterized public type is produced by
  the cast. The local cost the cast erases: the internal `.provide` excludes `Tag` and is
  re-typed to exclude the external `Self` for consumers.

The cast lives at exactly one seam and is pinned by `Capability.typetest.ts` + the unit
tests — never sprinkle `as` casts to route around a builder typing wrinkle; extend
`sealCapability` or the public `Capability*` types instead.

## Ports / adapters — the package names no kamp.us noun

`@kampus/authz` declares `CurrentActor`, `RelationStore`, and `AgentAuthority` as
`Context.Service` **ports** and knows nothing of fate, D1, or any product noun.
`features/kunye/` provides the adapter Layers (`CurrentActor` ← pasaport session;
`RelationStore` ← D1 tuples; standing ← künye) and owns the wire-coded errors. Adding an
authority model — a new right, a relation, a per-community role, admin — is an **additive
class declaration** against these stable primitives, never a central-file edit (the
agent-autonomous-growth north star). v1 is humans-only; v1.1 is a single `AgentAuthority`
Layer swap with no edit to the package.
</content>
</invoke>
