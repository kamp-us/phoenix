# Product-usage telemetry — the Analytics Engine seam

How to record and read product-usage telemetry in phoenix: one `Telemetry` service every
instrument emits through, a fixed positional event-schema owned in one module, and a
sampling-correct read contract. This is the **how-the-code-is-shaped** doc for the seam; the
*why* (why AE, why one seam, why the schema is shaped this way) is ADR
[0153](../.decisions/0153-analytics-engine-telemetry-seam.md) — link there, don't re-derive it.

The seam answers **"how much is feature X used, vs Y"** — not *who*, not *how many distinct
users*, not *do they return* (those are a future PostHog complement, ADR 0153 §Consequences).
Ground truth is the code under `apps/web/worker/features/telemetry/` (the service, the schema,
the test doubles) plus the two reference instruments (`features/vote/Vote.ts`,
`features/reaction/Reaction.ts`) and their wiring in `features/fate/layers.ts`. When this doc
and the source disagree, the source wins — fix the doc.

## The seam at a glance

| Piece | Where | What it is |
|---|---|---|
| `Telemetry` Tag + `emit` | `features/telemetry/Telemetry.ts` | the one narrow surface: `emit(event): Effect<void>` — no `E`, no `R` at the call-site |
| `TelemetryLive` | `features/telemetry/Telemetry.ts` | the isolate-level layer that discharges both channels inside itself |
| `TelemetryClient` | `features/telemetry/Telemetry.ts` | the init-resolved AE write-client seam (the `Database`-holds-the-D1-handle idiom) |
| `TelemetryEvent` + `toDataPoint` | `features/telemetry/schema.ts` | the **closed union** + the **single** positional field→slot map |
| `Events` dataset | `features/telemetry/resources.ts` | the `app_events` AE dataset (created on first write — no provisioning) |
| test doubles | `features/telemetry/Telemetry.testing.ts` | `recordingTelemetry` (assert the event) / `dyingTelemetry` (pin the fail-safe) |

The `Context.Service` + `Layer.effect` idiom is the phoenix service standard — the class-form
service, `return Telemetry.of({...})` from a `Layer.effect` generator — grounded upstream in
effect-smol `LLMS.md` §"Writing Effect services" → "Context.Service" and documented in
[effect-context-service.md](./effect-context-service.md). It mirrors the binding-as-service
shape of `Database`/`Flagship` (ADR [0028](../.decisions/0028-effect-durable-object-model.md)): the
binding is resolved **once per isolate in worker init** and carried on a dependency-free seam.

## The one invariant: telemetry can never fail the mutation it observes (S4)

Emitting is **fire-and-forget best-effort, never a source of truth** (ADR 0153). Internalize
this before anything else: a telemetry failure — an AE write error *or* a defect — must never
fail, unwind, or slow the mutation it observes. `emit`'s type is `Effect<void>` precisely
because **both a typed failure and a defect are contained inside `TelemetryLive`**, so a
call-site can neither route a telemetry error into its own error union nor be unwound by a
telemetry defect. **S4 is a property of the seam, not of each call-site** — instruments emit
BARE and inherit containment by construction (#2085).

Two discharges live in the layer (`Telemetry.ts`), so the call-site gets a clean `Effect<void>`:

- **The `RuntimeContext` requirement** `writeDataPoint` needs is captured once in the layer
  closure and `provideService`'d — the same pattern `LiveTopics.publish` uses in the worker.
- **The whole failure `Cause`** is swallowed with a log (`Effect.ignoreCause({log: "Warn"})`).
  This is the load-bearing choice: `Effect.ignoreCause` discards the **whole Cause — a typed
  `DatasetError` AND a defect (a `die`, a sync throw in `writeDataPoint`, a `toDataPoint` bug)
  and interruptions** — whereas `Effect.ignore` would discard only the typed `E` channel and let
  a defect propagate out. Containing the whole Cause **at the seam** is what makes `emit` a
  genuine `Effect<void>` that cannot fail OR die for every caller, so no instrument has to
  remember a call-site wrap. Grounded in effect-smol `Effect.ts` (`ignoreCause`: "Ignores the
  effect's failure cause, including defects and interruptions"; `ignore`: discards only the
  failure value).

```ts
// features/telemetry/Telemetry.ts — the seam contains the WHOLE Cause (defects included)
export const TelemetryLive = Layer.effect(
	Telemetry,
	Effect.gen(function* () {
		const client = yield* TelemetryClient;
		const runtimeContext = yield* RuntimeContext;
		return Telemetry.of({
			emit: (event) =>
				client.writeDataPoint(toDataPoint(event)).pipe(
					Effect.provideService(RuntimeContext, runtimeContext),
					// best-effort: log the whole Cause (error OR defect), return void — never fail
					// or die out of the caller (ADR 0153 S4). ignoreCause, not ignore: a defect must
					// be contained at the seam so every instrument gets S4 by construction (#2085).
					Effect.ignoreCause({log: "Warn"}),
				),
		});
	}),
);
```

The invariant is pinned by two tests in `Telemetry.unit.test.ts`: a `failingClient` whose
`writeDataPoint` fails with a `DatasetError` (the typed-failure case) **and** a `dyingClient`
whose `writeDataPoint` **dies** (the defect case) — both assert `emit` still exits **success**,
proving the seam contains error *and* defect.

## The fixed positional event-schema (one owner, `schema.ts`)

AE columns are **positional** — `index1`, `blob1..`, `double1..`; there is no named schema.
Fields must be written in **identical order across every event** or columns misalign
**silently**. So the field→slot map lives in exactly **one place**: `toDataPoint` in `schema.ts`.
A second mapping site is the exact failure mode this module exists to prevent.

The fixed layout:

| Slot | Holds | Why |
|---|---|---|
| `indexes: [feature]` | the one sampling/grouping key | AE gives **one** index (≤96 bytes, exact under sampling) — make it the **feature-key** (`vote`, `reaction`, …), the axis you compare on, so per-feature counts stay exact |
| `blobs: [feature, action, surface, userId?, emoji?]` | string dimensions | fixed positional order; `feature` is repeated into a blob because the index isn't a queryable string column |
| `doubles: [1]` | the count (or a measured quantity) | one row per event; weight it by `SUM(_sample_interval)` on read |

Guidance on which fields land where:

- **Index = the feature-key**, never `userId`. You get exactly one exact-under-sampling
  dimension; spend it on the axis you compare features on.
- **`userId` is a blob, deliberately approximate.** It enables rough per-user slicing, but
  distinct-user counts are *estimates* under sampling — never treated as exact. Precise per-user
  behaviour (funnels, retention, exact uniques) is the future PostHog seam, not a reason to
  reshape this one.
- **A trailing optional blob is dropped when absent** — but a *present* later optional with an
  *absent* earlier one must fill the earlier slot with a placeholder, or the column slides and
  silently misaligns. `toDataPoint` does this for `emoji` (blob5) over `userId` (blob4):

```ts
// features/telemetry/schema.ts — the SINGLE positional map (never a second mapping site)
export function toDataPoint(event: TelemetryEvent): Cloudflare.AnalyticsEngine.DataPoint {
	const emoji = event.feature === "reaction" ? event.emoji : undefined;
	const blobs = [event.feature, event.action, event.surface];
	if (event.userId !== undefined || emoji !== undefined) blobs.push(event.userId ?? "");
	if (emoji !== undefined) blobs.push(emoji); // stays at blob5; "" holds blob4 if userId absent
	return {indexes: [event.feature], blobs, doubles: [1]};
}
```

`TelemetryEvent` is a **closed discriminated union** on `feature` (make-invalid-states-
unrepresentable): each member is a per-feature event shape carrying its typed fields — no open
string bag, no raw data point. A non-member `feature` is a compile error. Event vocabulary is
**English/technical** (the glossary rule — telemetry is not product-facing copy, so it does not
take the Turkish product-noun rule).

## Add an instrument — the copy-me recipe

The two reference instruments (`Vote.cast`, `Reaction.react`) are the template. To instrument a
new feature, four edits:

**1. Add the event variant to the closed union in `schema.ts`.** One new member, its typed
fields, added to the `TelemetryEvent` union — never a raw `writeDataPoint` at the feature.

```ts
// features/telemetry/schema.ts
export interface BookmarkEvent {
	readonly feature: "bookmark";
	readonly action: string;
	readonly surface: string;
	readonly userId?: string;
}
export type TelemetryEvent = VoteEvent | ReactionEvent | BookmarkEvent;
```

**2. If the variant needs a new field, extend `toDataPoint` — the SINGLE positional owner.**
Never introduce a second mapping site; add the field at a fixed trailing slot with the same
placeholder discipline the `emoji` slot uses.

**3. Resolve `Telemetry` in the feature's layer and `emit` AFTER the committed mutation, on the
state-change tail.** Resolve it once at layer build (`const telemetry = yield* Telemetry`) — the
service is isolate-level, so there is no per-request wiring. Emit **only on a real state change**
and **after** the write commits, so a no-op or a rolled-back mutation emits nothing.

`Reaction.react` emits on the change tail — its early `changed: false` return means a no-op
re-react/retract emits nothing:

```ts
// features/reaction/Reaction.ts — emit AFTER the batch commits, only on a real change
yield* telemetry.emit({
	feature: "reaction",
	action: input.emoji === null ? "retract" : "react",
	surface: input.targetKind,
	userId: input.userId,
	...(input.emoji === null ? {} : {emoji: input.emoji}),
});
```

**4. Emit BARE — no call-site containment wrap.** Both reference instruments (`Vote.cast`,
`Reaction.react`) emit bare; the seam already contains the whole failure `Cause` (error **and**
defect), so a call-site `Effect.ignoreCause` would be pure redundancy:

```ts
// features/vote/Vote.ts — emit after the atomic batch commits; bare, seam-contained
yield* telemetry.emit({
	feature: "vote",
	action: isCast ? "cast" : "retract",
	surface: input.targetKind,
	userId: input.userId,
});
```

> **The seam uses `ignoreCause` so callers don't have to.** The `ignore` vs `ignoreCause`
> distinction still matters — it's just resolved **once, at the seam**, not at every call-site (why
> the whole-`Cause` discard, defects included, is the load-bearing choice is
> [The one invariant](#the-one-invariant-telemetry-can-never-fail-the-mutation-it-observes-s4)).
> Because `TelemetryLive` discharges it internally, `emit: Effect<void>` is genuinely
> unfailable-and-undyable for **every** instrument by construction — so a per-call-site wrap is
> redundant and instruments emit bare (#2085). Don't re-add a call-site `ignoreCause`: it
> duplicates a guarantee the seam already gives.

**5. Discharge the `Telemetry` layer requirement at `makeFateLayer`.** Emitting gives the
feature's `*Live` a build-time `Telemetry` requirement. Discharge it with `Layer.provide` at the
group where the instrument's layer is composed — `TelemetryLive` is also merged flat at the root
(like `Stats`), and the shared layer value memoizes to one isolate instance, so `Telemetry` stays
a worker output for future instruments while the in-group requirement is satisfied:

```ts
// features/fate/layers.ts — discharge Telemetry at the content group; keep it a flat output too
Layer.mergeAll(SozlukLive, PanoLive).pipe(
	Layer.provideMerge(VoteLive),
	Layer.provideMerge(ReactionLive),
	Layer.provide(TelemetryLive), // discharges the instruments' build-time Telemetry requirement
	// ...
),
// ...and merged flat at the root so Telemetry is a WorkerFateServices output:
TelemetryLive,
```

The `TelemetryClient`/`RuntimeContext` requirements of `TelemetryLive` bubble to the composition
root, where `TelemetryClient` is init-provided (worker init resolves
`Cloudflare.AnalyticsEngine.WriteDataset(Events)` once — where the binding graph is ambient — and
wraps it dependency-free, the same shape as `Flagship`/`Database`). See
[effect-layer-composition.md](./effect-layer-composition.md) for `provide` vs `provideMerge`.

## Testing an instrument

Substitute the `Telemetry` tag directly (the unit-tier seam substitution,
[effect-testing.md](./effect-testing.md)) — no database, no real AE. Two doubles ship in
`Telemetry.testing.ts`:

- **`recordingTelemetry(sink)`** — records every emitted event so a test asserts the exact
  `{feature, action, surface, emoji?}` shape it emitted, or that it emitted **nothing** on a
  no-op (an empty `sink`).
- **`dyingTelemetry`** — makes `emit` **die**, so an instrument test proves the write already
  committed **before** the (best-effort) emit — the emit is off the commit path. Note this double
  substitutes the `Telemetry` *tag*, so it **bypasses the real seam** and its assertion is
  commit-ordering only (the write is in `batches` even as the emit blows up); it does **not** run
  the defect through the real containment. The seam-level defect containment itself is pinned in
  `Telemetry.unit.test.ts`, below.

The production fail-safe is pinned by **two** cases in `Telemetry.unit.test.ts`, both substituting
the AE client at the `TelemetryClient` tag and running through the real `TelemetryLive`: a
`failingClient` whose `writeDataPoint` fails with a `DatasetError` (typed-failure containment) and
a `dyingClient` whose `writeDataPoint` **dies** (defect containment) — both assert `emit` still
succeeds, proving `Effect.ignoreCause` at the seam swallows error *and* defect (#2085).

## The read contract — reads are sampling-correct, and never from the Worker

Writing is in-repo; **reading is a contract, not code in this repo** (write it down, don't build
it — ADR 0153 §"Reads"):

- **Reads go through the external AE SQL API** (an Account Analytics Read token), **never from
  the Worker.** An in-app dashboard proxies through an authenticated backend route; the token is
  never exposed client-side.
- **Every query weights by `SUM(_sample_interval)`, never `count()`.** At phoenix's invite-only
  volume sampling almost never fires (`_sample_interval` = 1, so the weighted sum equals the raw
  count) — but writing `count()` bakes in a bug that only surfaces once volume grows and sampling
  kicks in. The canonical query (ADR 0153):

```sql
SELECT toStartOfDay(timestamp) AS day,
       sumIf(_sample_interval, index1 = 'vote')     AS votes,
       sumIf(_sample_interval, index1 = 'reaction') AS reactions
FROM app_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day
```

- **Retention is 3 months.** Anything needing longer history rolls up into D1 before it ages out.
- **The AE ceiling is "how much", not "who / how many distinct / do they return".** Exact
  uniques, funnels, and retention are out of scope by design — that is the future **PostHog
  complement** (a seam *alongside* AE), not a reason to reshape this one.

## Anti-patterns

- **A raw `writeDataPoint` in a feature.** No feature names Analytics Engine or constructs a data
  point — exactly as no feature names Drizzle or the LiveDO. Add a union member and `emit`.
- **A second field→slot mapping site.** The positional map lives only in `toDataPoint`; a second
  one silently misaligns columns.
- **Emitting before the commit, or on a no-op.** Emit after the mutation commits, on the
  state-change tail only, so a rolled-back or idempotent-no-op mutation emits nothing.
- **`Effect.ignore` at the seam.** The seam (`TelemetryLive`) must use `Effect.ignoreCause`, not
  `Effect.ignore` — `ignore` leaves defects on the mutation's critical path; only `ignoreCause`
  contains the whole Cause so S4 holds by construction for every caller (#2085).
- **A call-site containment wrap on `emit`.** Instruments emit **bare** — the seam already
  contains error *and* defect, so a call-site `Effect.ignoreCause`/`Effect.ignore` is redundant
  and drifts the pattern; don't re-add one.
- **Routing telemetry into a call-site's error union.** `emit` is `Effect<void>`; never widen it.
- **`count()` in a read query, or reading from the Worker.** Weight by `SUM(_sample_interval)`
  and read only through the external SQL API.
- **Per-domain datasets.** One `app_events` dataset, partitioned by the index + blobs; split
  later only if a domain needs different retention/schema.

## See also

- ADR [0153](../.decisions/0153-analytics-engine-telemetry-seam.md) — the *why*: AE as the seam,
  the schema convention, sampling-correct reads, the PostHog complement.
- [effect-context-service.md](./effect-context-service.md) — the `Context.Service` + `Layer.effect`
  idiom the seam is built on.
- [effect-layer-composition.md](./effect-layer-composition.md) — `Layer.provide` vs `provideMerge`
  for discharging the `Telemetry` requirement.
- [effect-testing.md](./effect-testing.md) — the unit-tier tag-substitution the instrument tests use.
- [feature-services.md](./feature-services.md) — the one-service-per-feature shape the instruments follow.
