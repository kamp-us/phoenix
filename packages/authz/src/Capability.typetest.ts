/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): an op that
 * declares a capability in its requirements channel **fails to compile** unless
 * the proof is discharged via `Grant.provide` at composition. This is the
 * "forgot to authorize is a compile error" guarantee of ADR 0107 §1, made
 * falsifiable by inspecting the **R channel** with `expectTypeOf`: omit
 * `Grant.provide` and the capability stays required in R (≠ `never`); provide it
 * and R collapses to `never`. The assertion is a real `tsgo` error the moment
 * either half stops holding. (#1270 collapsed the per-capability `.provide` to a
 * single generic `Grant.provide`; the forgot-to-provide guarantee is unchanged.)
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

/** The requirements (R) channel of an effect type. */
type RequirementsOf<T> = [T] extends [Effect.Effect<unknown, unknown, infer R>] ? R : never;

const ladder = Scale(["visitor", "çaylak", "yazar"]);

class OpenTerm extends Capability.Level<OpenTerm>()("test/OpenTerm", {
	scale: ladder,
	min: "yazar",
	read: () => Effect.succeed("yazar" as const),
	deny: () => new Error("requires yazar"),
}) {}

declare const grant: Grant<OpenTerm>;

/** A privileged op declares the proof in its R channel and reads it back. */
const op: Effect.Effect<string, never, OpenTerm> = Effect.gen(function* () {
	const proof = yield* OpenTerm;
	return proof.scope.capability;
});

/** Providing the proof discharges the requirement — R collapses to `never`. */
export const discharged: Effect.Effect<string, never, never> = op.pipe(Grant.provide(grant));

// The authorization gate, as an R-channel assertion:
//   - omit `Grant.provide` → `OpenTerm` stays required in R (the proof is mandatory);
//   - provide it → R collapses to `never` (the requirement is discharged).
// Either half breaking is a `tsgo` error here.
expectTypeOf<RequirementsOf<typeof op>>().toEqualTypeOf<OpenTerm>();
expectTypeOf<RequirementsOf<typeof discharged>>().toEqualTypeOf<never>();

/** The discharge verb requires the ports — never the proof it produces. */
export const required: Effect.Effect<
	Grant<OpenTerm>,
	Error,
	CurrentActor | AgentAuthority
> = OpenTerm.require;
