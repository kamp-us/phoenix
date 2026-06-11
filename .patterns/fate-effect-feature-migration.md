# fate-effect feature shape — the per-feature assembly (migration record)

How a phoenix feature's fate aggregator files look on the `@phoenix/fate-effect` constructors — sozluk (`apps/web/worker/features/sozluk/`) is the shipped reference; pano, pasaport, and stats followed this template (every feature is migrated). The short answer: **the feature keeps its file layout ([per-feature-fate-aggregators.md](./per-feature-fate-aggregators.md)) and its domain service untouched; only the five fate-facing modules rewrite in place** — views become `FateDataView` classes, sources become `Fate.source`, queries/lists/mutations become def + `Effect.fn` pairs, errors gain `ErrorCode` annotations, live publishes go through `LivePublisher`. The per-construct docs ([fate-effect-data-views.md](./fate-effect-data-views.md), [fate-effect-sources.md](./fate-effect-sources.md), [fate-effect-operations.md](./fate-effect-operations.md), [fate-effect-wire-errors.md](./fate-effect-wire-errors.md)) own each piece; this doc is the per-feature assembly.

## What changes, file by file

| File | Before (bridge) | After (`Fate.*`) |
|---|---|---|
| `errors.ts` | plain `Schema.TaggedErrorClass`es, wire codes in the central `WIRE_CODE_BY_TAG` registry | same classes + `{[ErrorCode]: "<CODE>"}` third parameter — codes copied **verbatim** from the registry row; a class behind an `upcased` registry arm (dynamic instance `code`) splits into one class per sub-code with a union alias + members tuple (pano's `PostValidation`/`CommentValidation`, pasaport's `UsernameInvalid` — see [fate-effect-wire-errors.md](./fate-effect-wire-errors.md) "One class, one code"); an `errors.unit.test.ts` enumeration pin per pair |
| `views.ts` | `dataView()` consts annotated `DataViewOf`, hand-rolled `EntityOf` types | `FateDataView<Row>()("Name")({fields})` classes; `Entity<typeof View, Replacements>` types; kernel-view consts (`export const termDataView = TermView.view`) kept for the `fate/views.ts` barrel + `Root` |
| `sources.ts` | `fateSource<Row>({...})` executor + hand-written `AnySourceDefinition` literal | one `Fate.source(ViewClass, {id}, handlers)` per entity; the `SourceExecutor`/`AnySourceDefinition` annotations and casts disappear. A **synthetic** entity with no fetch path keeps a capability-less registration as a hand-built `AnyFateSourceEntry` (pasaport's `Contribution`); a **root-only** synthetic entity stays sourceless via a string-typed query (stats' `LandingStats`) — see [fate-effect-sources.md](./fate-effect-sources.md) "The escape hatch" |
| `queries.ts` / `lists.ts` / `mutations.ts` | `{type, resolve: fateQuery<Args, A>(...)}` records, hand-typed args/inputs | `Fate.query/list/mutation({args/input, type: ViewClass, error}, Effect.fn("<wire name>")(function* ...))` — Schema replaces the hand-typed generics; handler bodies keep their generator content |
| `features/fate/sources.ts` | `{definition, executor}` pair entries | the feature's entries become the bare `Fate.source` values in the same array slot |

Nothing else moves: `config.ts`/`layers.ts`/`route.ts`/`schema.ts` are untouched by a feature migration (the [worker wiring](./fate-effect-worker-wiring.md) was built for exactly this swap), the barrels (`fate/queries.ts` etc.) keep their spreads, the SPA keeps importing entity types from `worker/features/fate/views`, and the generated client is byte-identical (checked by diff for sozluk).

## The per-request pair replaces `Auth` and `LiveBus`

Migrated handlers must not yield the bridge's per-request services — the compiler provides only `CurrentUser` and `LivePublisher`:

- `yield* Auth` → `const {user} = yield* CurrentUser` (anonymous reads), `Auth.required` → `const user = yield* CurrentUser.required` (gated writes — fails with the package's `Unauthorized`, annotated `UNAUTHORIZED`, so it must appear in the mutation's declared `error` union).
- `liveBus.useIgnore((bus) => bus.connection(...).appendNode(...))` → `const live = yield* LivePublisher; yield* live.connection(...).appendNode(...)`. No `useIgnore`: every publish method's error channel is `never` by construction ([fate-effect-server.md](./fate-effect-server.md)). Topic keys and frames are unchanged — `livePublisherFor` builds them through the same `makeLiveEventBus` path the bridge bus used.

## Infra failures die — inside the domain service, not in fate handlers

The loader contract (*infra failures are defects*) still holds, but the WHERE moved: domain services die on `DrizzleError` INSIDE their implementations (`orDieAccess` over the Drizzle `run`/`batch` at layer build — see [feature-services.md](./feature-services.md)), so their public method signatures carry domain errors only. A fate handler therefore calls the service bare — no `orDieDrizzle` pipe, no `Drizzle` import anywhere in `sources.ts`/`queries.ts`/`lists.ts`/`mutations.ts`:

```ts
const result = yield* sozluk.addDefinition({...}); // E: BodyRequired | BodyTooLong — already domain-only
```

Domain errors stay in the handler's `E` (checked against the declared union at the constructor call). A DB failure reaches the wire as `INTERNAL_SERVER_ERROR` + the fixed message via the defect path of `encodeWireError` — `cause` goes to logs, never the client. Sources' `E = never` and operations' domain-only unions now hold by the service types alone; `worker/features/domain-error-boundary.unit.test.ts` pins this per service.

## Entity types: `Entity<typeof View, Replacements>`

Two restatements ride in the `Replacements` parameter (see `sozluk/views.ts`):

- **list relations** — kernel `list()` widens the child field map, fate's own documented reason for `Replacements` (`definitions?: Definition[]`);
- **timestamp fields** — fate's `Entity<>` types `Date` row fields as `string` (the JSON wire shape), but worker-side entity values carry live `Date` objects until fate serializes the response. The shapers and every worker call site are pre-serialization, so restate them (`createdAt: Date`, …) to keep the bridge-era types — otherwise every shaper literal breaks.

## Input/args Schemas

- Mutation inputs: `Schema.Struct` mirroring the wire fields (`Schema.optional(Schema.NullOr(...))` for `field?: T | null`). Domain validation stays in the service (ADR 0013) — the Schema only types the boundary; an invalid *shape* now rejects pre-handler as `VALIDATION_ERROR` (fate's own schema-failure code).
- Query/list args: structs of `Schema.optional` fields (absent wire args decode as `{}`), except genuinely required identifiers (`term(slug)` declares `slug: Schema.String` — the generated client requires it anyway). Defensive `typeof args?.x === "number"` reads become `args.x ?? DEFAULT` — the Schema already proved the type.
- Nested connection args keep fate's field-path scoping (`args.definitions.{first,after}`) as a nested optional struct.

## Tests

- The feature's T2 suites (`bridge-<feature>*.test.ts`) port **without edits** — `runFateOp` v2 already serves both record kinds and captures `LivePublisher` publishes into the same `published` array of resolved topic keys.
- Add the app-side wire-code enumeration pin (`<feature>/errors.unit.test.ts`, T0): every error class ↔ code pair via `wireCodeOfClass`, codes pinned to the bridge registry's values, plus one `encodeWireError` round-trip.
- Live end-to-end: one T3 case in `tests/integration/fate-live.test.ts` subscribes to a topic the mutation publishes to and asserts the frame arrives (the sozluk `definition.add` → args-scoped `Term.definitions` `appendNode` case is the reference).

## What not to do

- Don't keep `Auth`/`LiveBus` in a migrated handler — the compiled pipeline doesn't provide them; the handler's `R` will surface them and `FateServer.layer`'s composition site fails to typecheck (they are worker singletons' per-request values, not layers).
- Don't declare `DrizzleError` in an operation's `error` union or annotate it with a wire code — its message could carry DB detail onto the wire. It can't appear there anyway: the services defect-ify it internally, and a fate-layer file that names `Drizzle` at all is reintroducing the abstraction leak this boundary removed.
- Don't delete the feature's kernel-view consts (`termDataView = TermView.view`) while the cross-feature `Root`/barrel still consume kernel views — they are the codegen walk's input.
- Don't hand the wire types a new shape "while you're in there" — the migration's contract is byte-identical operation results, codegen text, topic keys, and wire codes; the T2 suites and the codegen diff are the proof.
