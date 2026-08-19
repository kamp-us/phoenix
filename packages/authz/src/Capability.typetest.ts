/**
 * Type-level assertions (no runtime — checked by `tsgo`, not vitest) that make the
 * "forgot to authorize is a compile error" guarantee of ADR 0107 §1 falsifiable.
 *
 * It reads R off the effect type rather than asserting an *assignment* (the prior
 * `@ts-expect-error`'d `leaked` form): assigning a service-requiring effect to an
 * `R = never` annotation tripped the plugin's `effect(missingEffectContext)`
 * diagnostic (TS377004), which `@ts-expect-error` does not catch — leaving the
 * typetest itself red. Inspecting the channel proves the same guarantee cleanly.
 */
import {Effect} from "effect";
import {expectTypeOf} from "vitest";
import type {AgentAuthority} from "./AgentAuthority.ts";
import {Capability} from "./Capability.ts";
import type {CurrentActor} from "./CurrentActor.ts";
import {Grant} from "./Grant.ts";
import {Scale} from "./Level.ts";

type RequirementsOf<T> = [T] extends [Effect.Effect<unknown, unknown, infer R>] ? R : never;

const ladder = Scale(["visitor", "çaylak", "yazar"]);

class OpenTerm extends Capability.Level<OpenTerm>()("test/OpenTerm", {
	scale: ladder,
	min: "yazar",
	read: () => Effect.succeed("yazar" as const),
	deny: () => new Error("requires yazar"),
}) {}

/** A second, distinct capability — its proof must NOT be the same type as OpenTerm's. */
class OtherCap extends Capability.Level<OtherCap>()("test/OtherCap", {
	scale: ladder,
	min: "yazar",
	read: () => Effect.succeed("yazar" as const),
	deny: () => new Error("requires yazar"),
}) {}

declare const grant: Grant<OpenTerm>;
declare const wrongGrant: Grant<OtherCap>;

const op: Effect.Effect<string, never, OpenTerm> = Effect.gen(function* () {
	const proof = yield* OpenTerm;
	return proof.scope.capability;
});

export const discharged: Effect.Effect<string, never, never> = op.pipe(Grant.provide(grant));

// The authorization gate, as an R-channel assertion:
//   - omit `Grant.provide` → `OpenTerm` stays required in R (the proof is mandatory);
//   - provide it → R collapses to `never` (the requirement is discharged).
// Either half breaking is a `tsgo` error here.
expectTypeOf<RequirementsOf<typeof op>>().toEqualTypeOf<OpenTerm>();
expectTypeOf<RequirementsOf<typeof discharged>>().toEqualTypeOf<never>();

// The wrong-proof gate (#1483): a proof of one right is NOT a proof of another. The
// sealed `CapabilityTag` carries each capability's `id` literal, so `Grant<X>` ≢ `Grant<Y>`
// for distinct capabilities. Pre-fix these unified (the seal widened `id` to `string`),
// which made this assertion fail; carrying the `Id` literal makes the distinction a
// tsgo-checked fact.
expectTypeOf(grant).not.toEqualTypeOf(wrongGrant);

export const required: Effect.Effect<
	Grant<OpenTerm>,
	Error,
	CurrentActor | AgentAuthority
> = OpenTerm.require;
