# Project, never cast, at a strict-schema wire boundary

A dependency's in-memory type and the wire schema it feeds are two different types even when every
field lines up today. When the wire schema is **strict** — `additionalProperties: false` — a value
that merely *extends* the wire's shape is rejected, and it is rejected at encode time, on the field
a provider happened to fill, in production. So the boundary carries an explicit projection: a
function that names each field that crosses, and drops everything else by construction.

Where this lives today: [`apps/tuval/src/pi/server/`](../apps/tuval/src/pi/server/) —
[`cost.ts`](../apps/tuval/src/pi/server/cost.ts) for model pricing and
[`transcript.ts`](../apps/tuval/src/pi/server/transcript.ts) for messages, both feeding
Tuval's own wire vocabulary in [`pi/wire/`](../apps/tuval/src/pi/wire/).

**Read the "where this stops applying" section before reaching for the negative test.** Tuval's own
boundary stopped being strict at the 0.85.1 Pi upgrade: protocol 8 carries every payload opaque
(ADR [0366](../.decisions/0366-tuval-keeps-own-pi-host.md)), so the encoder no longer refuses an
unprojected value and the projection is now the *only* thing keeping one off the wire — a stronger
reason to keep it, and a rule-3 the instance can no longer satisfy.

## Why a cast is the wrong tool

Pi's own types are supersets of the wire's, and the extra fields are optional, so a cast compiles
and the happy path passes:

- `ModelCost` is `ModelCostRates` plus an optional `tiers` array
  (`@earendil-works/pi-ai` `dist/types.d.ts:691-694`), while Tuval's own `ModelCost`
  (`pi/wire/model.ts`) is exactly the four rates.
- `TextContent` carries `textSignature`, `ThinkingContent` carries `thinkingSignature`, `Usage`
  carries `cacheWrite1h` (`@earendil-works/pi-ai` `dist/types.d.ts:237-286`) — none of them declared on the wire.

Every one of those is filled only by *some* provider, on *some* model. A cast therefore ships an
encoder that works until the day a model is priced in tiers or a provider returns a signature, and
then fails inside the transport with a validation error naming nothing the caller recognises.

## The shape

One exported function per boundary type, taking a structural description of the source and
returning the wire type:

```ts
export interface SourceModelCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly tiers?: ReadonlyArray<unknown> | undefined;
}

export const projectModelCost = (cost: SourceModelCost): ProtocolModelCost => ({
	input: cost.input,
	output: cost.output,
	cacheRead: cost.cacheRead,
	cacheWrite: cost.cacheWrite,
});
```

Three rules make it hold:

1. **Name the source structurally, not by importing its type.** The projection then depends on the
   shape it reads, not on which package version declares it, and a dependency bump that adds a
   field cannot silently widen what crosses.
2. **Enumerate the target's fields literally.** No spread of the source, no `Object.assign`, no
   `omit`. A spread re-opens exactly the hole the pattern closes.
3. **Test the negative, where the encoder still gives you one.** Where the wire schema is strict,
   the assertion that earns its place is that the *unprojected* value is refused — encode it and
   assert the throw, then encode the projected one and assert it passes. Where it is not (Tuval's
   own boundary since protocol 8), assert instead that the projection drops the field, and say in
   the test why the encoder is no longer the one asserting it. Either way the half that proves only
   "the four fields were copied" is not the whole test.

See [`projections.unit.test.ts`](../apps/tuval/src/pi/server/projections.unit.test.ts).

## The bound is not the only refusal

A strict schema usually also carries value bounds, and a real catalog will violate them. Pi's
openrouter auto-router models price themselves at `-1000000` as a "varies" sentinel, and Tuval's own
wire type floors every rate at `0`. A value the wire cannot describe is **left out**, not clamped:
`describable` in [`AgentSessionHost.ts`](../apps/tuval/src/pi/server/AgentSessionHost.ts) drops
those two rows, because clamping would quote a price that is not the model's.

## Where this stops applying

It is about a *strict* wire schema. A boundary whose target permits unknown fields needs no
projection for correctness — though it may still want one so the wire's payload is a decision
rather than an accident. And a boundary you own on both sides is better fixed by making the two
types one type; this pattern is for the boundary where the far side's schema is not yours to
change.
