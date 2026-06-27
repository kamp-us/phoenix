/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): an op that
 * declares a capability in its requirements channel **fails to compile** unless
 * the proof is provided via `.provide` at composition. This is the
 * "forgot to authorize is a compile error" guarantee of ADR 0107 §1, made
 * falsifiable: the `@ts-expect-error` below is *unused* (a TS2578 typecheck
 * failure) the moment omitting `.provide` stops being an error.
 */
import {Effect} from "effect";
import type {AgentAuthority} from "./AgentAuthority.ts";
import {Capability} from "./Capability.ts";
import type {CurrentActor} from "./CurrentActor.ts";
import type {Grant} from "./Grant.ts";
import {Scale} from "./Level.ts";

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
export const discharged: Effect.Effect<string, never, never> = op.pipe(OpenTerm.provide(grant));

/**
 * Omitting `.provide` leaves `OpenTerm` in R, so the op is NOT `R = never`.
 * Assigning it to an `R = never` type must be a type error — that error is the
 * authorization gate.
 */
// @ts-expect-error — the proof was never provided; `OpenTerm` remains required in R.
export const leaked: Effect.Effect<string, never, never> = op;

/** The discharge verb requires the ports — never the proof it produces. */
export const required: Effect.Effect<
	Grant<OpenTerm>,
	Error,
	CurrentActor | AgentAuthority
> = OpenTerm.require;
