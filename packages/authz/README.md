# @kampus/authz

The **vocab-free** capability-as-Effect authorization mechanism — [ADR 0107](../../.decisions/0107-capability-authz-framework.md). It names **no** kamp.us noun, no fate, no D1: bare primitives, the sealed `Grant`, and the class-as-capability builders.

## What it is

A privileged op requires an unforgeable proof, `Grant`, in its requirements (R) channel. The only way to obtain one is to discharge a check; **omitting the proof is a compile error**, and so is supplying the wrong right's proof — each capability's tag carries its id literal, so `Grant<X>` ≢ `Grant<Y>` for distinct capabilities (#1483). The proof flows into R through the single canonical `Grant.provide(grant)` — never a field on the op's domain input. `Grant.provide` routes by the key the grant itself carries, so one verb discharges every capability, and a mismatched grant left in R fails loud instead of silently satisfying anything.

| Piece | Role |
| --- | --- |
| `Actor` | `Unauthenticated \| Authenticated(Human \| Agent)` — the dispatch root; the agent arm is the dormant v1 seam |
| `Resource` | a generic recursive tree node (`type`, `id`, optional `parent`); `ancestry`/`covers` give relation authority its scope, `key` the one `type:id` storage encoding, `platform` the root |
| `Scale` | an ordered ladder of caller-supplied rank names (lowest-authority first) with monotone `gte` — the RBAC/MLS-shaped earned-standing axis |
| `Relation` + `RelationStore` | the ReBAC `(subject, relation, object)` primitive + its storage-blind port: point `has`, batched `hasSubjects`, and the open-set `subjectsOf` (who holds a tuple, when no candidate ids are known up front) |
| `Grant` | the **sealed** proof: `mint` never escapes the package (the type + `Grant.provide` + the `isGrant` guard do), and there is no `Schema`/decode path — a decodable proof would be forgeable |
| `Capability.Class` / `.Level` / `.Relation` | the class-as-capability builders — one declaration yields the nominally-distinct proof tag, the `Grant` type, and the discharge verb (`.authorize(check)` / `.require` / `.over(resource)`; discharge into R is always the shared `Grant.provide`) |
| `CurrentActor` / `RelationStore` / `AgentAuthority` | the ports (`Context.Service` classes), adapted in `features/kunye` |

## Why it exists

[ADR 0107](../../.decisions/0107-capability-authz-framework.md) is the forcing decision: authorization enforced by the type system's R channel, not by runtime middleware that can be forgotten. The full derivation — builder → discharge verb → sealed `Grant` → `Grant.provide`, the compile-error guarantee, and the one audited cast — lives in [authz-capability-as-effect.md](../../.patterns/authz-capability-as-effect.md); this README points at it rather than restating it.

Scope boundary: the kamp.us capability instances (`OpenTerm`/`AddEntry`/`Moderate`/`Admin`), the wire-coded denial errors, and every `*Live` adapter Layer (including the fail-closed v1 `AgentAuthority` and the D1-backed `RelationStore`) live in `features/kunye`, not here. This package declares ports only; nothing here reads a database or speaks a wire format.

## How to use it

Declare a capability where your domain lives (here shown with kunye's ladder):

```ts
class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale, // Scale(["visitor", "çaylak", "yazar"])
	min: "yazar", // the floor
	read, // (principal) => Effect<rank> — reads standing
	deny, // () => RequiresLevel — your typed denial
}) {}

// discharge → a proof, or a typed denial in E
const grant = yield* OpenTerm.require;

// the privileged op declares the proof in R; `Grant.provide` discharges it
openTerm.pipe(Grant.provide(grant)); // R: never
```

`.require` discharges a `Level`, `.over(resource)` a `Relation`, `.authorize(check)` the generic `Class`. Each dispatches exhaustively on the `Actor`: anonymous denies, a human checks directly, and an agent reads its human root's standing and consults `AgentAuthority` — whose v1 Layer is fail-closed, so v1 grants no agent any authority. v1.1 is that one Layer swapped, with no edit to this package.

## Reference

One export surface, the package root (`exports["."]` = `src/index.ts`; no bin). By module:

| Module | Exports |
| --- | --- |
| `Actor` | types `Actor`, `Principal`, `Human`, `Agent`, `Authenticated`, `Unauthenticated`; values `human(id)`, `agent(id, root)`, `unauthenticated`, `matchActor` |
| `Resource` | type `Resource`; values `resource(type, id, parent?)`, `platform`, `key(node)`, `sameNode(a, b)`, `ancestry(node)`, `covers(ancestor, node)` |
| `Level` | `Scale(order)` → `{order, rank, gte, has}` |
| `Relation` | type `Relation` `{subject, relation, object}`; class `RelationStore` — the port with `has`, `hasSubjects({subjects, relation, object})`, `subjectsOf({relation, object})` (all direct-tuple, no ancestry walk) |
| `Grant` | type `Grant<M>` + `GrantScope`; value `Grant.provide(grant)`; guard `isGrant(value)` — `mint` is deliberately absent |
| `Capability` | `Capability.{Class, Level, Relation}`, each `<Self>()(id, config)`; config/capability types (`ClassConfig`, `LevelConfig`, `RelationConfig`, `CapabilityTag`, `ClassCapability`, `LevelCapability`, `RelationCapability`) |
| Ports | `CurrentActor` (`{actor}`), `AgentAuthority` (`admits({agent, capability})`), plus `AgentAuthorityRequest` |

Package scripts: `test` (vitest run) and `typecheck` (`tsc -p tsconfig.json`).

## Testing

```bash
pnpm --filter @kampus/authz test
pnpm --filter @kampus/authz typecheck
```

Pure-primitive unit tests cover the `Grant` seal, `Scale` ordering, `Resource` ancestry/covers, and the builders' exhaustive Actor dispatch + provision into context. `Capability.typetest.ts` holds the compile-error guarantees (checked by `typecheck`, not vitest): omitting `Grant.provide` fails to compile, and a wrong-right proof fails to compile (#1483).
