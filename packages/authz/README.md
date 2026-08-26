# @kampus/authz

The **vocab-free** capability-as-Effect authorization mechanism —
[ADR 0107](../../.decisions/0107-capability-authz-framework.md).

## What it is

A privileged op requires an unforgeable proof, `Grant`, in its requirements (R)
channel. The only way to obtain one is to discharge a capability check;
**omitting the proof is a compile error**. The proof flows through context via the
single canonical `Grant.provide(grant)`, never a field on the op's domain input.
Capabilities are **nominally distinct**: the sealed tag carries each capability's
id literal, so `Grant<X>` is not `Grant<Y>` and a wrong-right proof is a compile
error too (#1483, fixed in #1523).

The shape of the mechanism — builder → discharge verb → sealed `Grant` →
`Grant.provide`, the compile-error guarantee, and the one audited cast — is the
[authz-capability-as-effect](../../.patterns/authz-capability-as-effect.md)
pattern; read it there rather than here.

## Why it exists

ADR 0107 makes "forgot to check" a compile error and lets authorization grow by
adding modules, superseding the role-column and better-auth-AC approaches. This
package is the mechanism half of that decision, and it is deliberately vocab-free:
it names **no** kamp.us noun, no fate, no D1. The kamp.us capability instances
(`OpenTerm`/`AddEntry`/`Moderate`/`Admin`), the wire-coded errors, and the `*Live`
adapter Layers live in `features/kunye`, not here. The Human/Agent split is a
dormant v1 seam: every discharge verb already routes the `Agent` arm through the
`AgentAuthority` port, whose **v1 Layer is fail-closed** (no agent gets any
authority) — v1.1 is that one Layer swapped, with no edit here.

## How to use it

Declare a capability (in `features/kunye`) and discharge it:

```ts
class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale, // Scale(["visitor", "çaylak", "yazar"])
	min: "yazar",
	read, // (principal) => Effect<rank> — reads künye standing
	deny, // () => RequiresLevel — the wire-coded error
}) {}

// discharge → a proof, or a typed denial
const grant = yield* OpenTerm.require;

// the privileged op declares the proof in R; `Grant.provide` discharges it
openTerm.pipe(Grant.provide(grant)); // R: never
```

`.require` discharges a `Level`, `.over(resource)` a `Relation`, `.authorize(check)`
the generic `Class`. Each dispatches exhaustively on the `Actor`: anonymous denies,
a human checks directly, and an agent reads its human root's standing and consults
`AgentAuthority`. `Grant.provide` is generic over `Grant<C>`: it routes by the
capability key the grant itself carries — one verb across every capability, and a
wrong-capability grant leaves the requirement unsatisfied and fails loud instead of
silently passing.

## Surface

| Piece | Role |
| --- | --- |
| `Actor` | `Unauthenticated \| Authenticated(Human \| Agent)` — the dispatch root; built with `unauthenticated`/`human(id)`/`agent(id, root)`, matched exhaustively with `matchActor` |
| `Resource` | a generic recursive tree; `covers`/`ancestry` give relation authority its scope, `resource`/`key`/`platform`/`sameNode` build and compare nodes |
| `Scale` (Level) | an ordered ladder with `gte` — the RBAC/MLS-shaped earned-standing axis |
| `Relation` + `RelationStore` | the ReBAC `(subject, relation, object)` primitive + its storage-blind port: `has` (one tuple; discharge walks `ancestry`, asking once per ancestor), `hasSubjects` (the batched form — one read for N subjects, no ancestry walk), `subjectsOf` (the open-set read: every subject holding a tuple, the mod fan-out primitive — #1699) |
| `Grant` | the **sealed** proof: constructor never exported (the type, `isGrant`, and the `Grant.provide` discharge verb escape, never `mint`), **not** a `Schema` (a decodable proof would be forgeable) |
| `Capability.Class` / `.Level` / `.Relation` | the class-as-capability builders — one declaration yields the proof tag, the `Grant` type, and the discharge verb (discharge into R is the shared `Grant.provide`) |
| `CurrentActor` / `RelationStore` / `AgentAuthority` | the ports (`Context.Service`s), adapted in `features/kunye` |

Capabilities key off **`Context.ServiceClass<Self, Id, Grant<Self>>`** (effect v4 —
`Context.Tag` is a v3 type that does not exist in v4). The tag carries the `Id`
string literal, which is what keeps each capability's `Grant` a distinct type.

## Testing

`pnpm test` — pure-primitive unit tests: the `Grant` seal, `Scale` ordering,
`Resource` ancestry/covers, the builders' exhaustive Actor dispatch + `Grant`
provision into context. `Capability.typetest.ts` is the compile-time assertion
(checked by `pnpm typecheck`): omitting `Grant.provide` leaves the capability in R,
providing it collapses R to `never`, and a second capability's `Grant` is a
distinct type — the wrong-proof gate.
