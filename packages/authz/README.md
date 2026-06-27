# @kampus/authz

The **vocab-free** capability-as-Effect authorization mechanism — [ADR 0107](../../.decisions/0107-capability-authz-framework.md).
It names **no** kamp.us noun, no fate, no D1. The kamp.us capability instances
(`OpenTerm`/`AddEntry`/`Moderate`/`Admin`), the wire-coded errors, and the `*Live`
adapter Layers live in `features/kunye`, not here.

## What it is

A privileged op requires an unforgeable proof, `Grant`, in its requirements (R)
channel. The only way to obtain one is to discharge a check; **omitting the proof is a
compile error**. The proof flows through context via `.provide(grant)` — the
`provideService` idiom of effect-smol's `HttpApiMiddleware` Authorization fixture
(check → provide a typed proof), never a field on the op's domain input.

| Piece | Role |
| --- | --- |
| `Actor` | `Unauthenticated \| Authenticated(Human \| Agent)` — the dispatch root; the agent arm is the dormant v1 seam |
| `Resource` | a generic recursive tree; `covers`/`ancestry` give relation authority its scope |
| `Scale` (Level) | an ordered ladder with `gte` — the RBAC/MLS-shaped earned-standing axis |
| `Relation` + `RelationStore` | the ReBAC `(subject, relation, object)` primitive + its storage-blind port |
| `Grant` | the **sealed** proof: constructor never exported (only the type escapes), **not** a `Schema` (a decodable proof would be forgeable) |
| `Capability.Class` / `.Level` / `.Relation` | the class-as-capability builders — one declaration yields the proof tag, the `Grant` type, the discharge verb, and `.provide` |
| `CurrentActor` / `RelationStore` / `AgentAuthority` | the ports (`Context.Service`s), adapted in `features/kunye` |

Capabilities key off **`Context.Key<Self, Grant<Self>>`** (effect-smol v4) — `Context.Tag`
is a v3 type that does not exist in v4.

## Declaring a capability (in `features/kunye`)

```ts
class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale, // Scale(["visitor", "çaylak", "yazar"])
	min: "yazar",
	read, // (principal) => Effect<rank> — reads künye standing
	deny, // () => RequiresLevel — the wire-coded error
}) {}

// discharge → a proof, or a typed denial
const grant = yield* OpenTerm.require;

// the privileged op declares the proof in R; `.provide` discharges it
openTerm.pipe(OpenTerm.provide(grant)); // R: never
```

`.require` discharges a `Level`, `.over(resource)` a `Relation`, `.authorize(check)` the
generic `Class`. Each dispatches exhaustively on the `Actor`: anonymous denies, a human
checks directly, and an agent reads its human root's standing and consults
`AgentAuthority` — whose **v1 Layer is fail-closed**, so v1 grants no agent any authority.
v1.1 is that one Layer swapped, with no edit here.

## Tests

`pnpm test` — pure-primitive unit tests: the `Grant` seal, `Scale` ordering, `Resource`
ancestry/covers, the builders' exhaustive Actor dispatch + `Grant` provision into context.
`Capability.typetest.ts` is the compile-error assertion (checked by `pnpm typecheck`):
omitting `.provide` fails to compile.
