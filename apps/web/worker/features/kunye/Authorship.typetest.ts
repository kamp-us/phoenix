/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): an op declaring `OpenTerm` /
 * `AddEntry` in its requirements channel fails to compile unless the matching `Grant` is provided
 * (ADR 0107 §1, the "forgot to authorize is a compile error" guarantee).
 */
import {type AgentAuthority, type CurrentActor, Grant} from "@kampus/authz";
import {Effect} from "effect";
import {expectTypeOf} from "vitest";
import {AddEntry, OpenTerm} from "./Authorship.ts";
import type {RequiresLevel} from "./errors.ts";
import type {Kunye} from "./Kunye.ts";

type RequirementsOf<T> = [T] extends [Effect.Effect<unknown, unknown, infer R>] ? R : never;

declare const openTermGrant: Grant<OpenTerm>;
declare const addEntryGrant: Grant<AddEntry>;

const openOp: Effect.Effect<string, never, OpenTerm> = Effect.gen(function* () {
	const proof = yield* OpenTerm;
	return proof.scope.capability;
});

const addOp: Effect.Effect<string, never, AddEntry> = Effect.gen(function* () {
	const proof = yield* AddEntry;
	return proof.scope.capability;
});

export const openDischarged: Effect.Effect<string, never, never> = openOp.pipe(
	Grant.provide(openTermGrant),
);
export const addDischarged: Effect.Effect<string, never, never> = addOp.pipe(
	Grant.provide(addEntryGrant),
);

expectTypeOf<RequirementsOf<typeof openOp>>().toEqualTypeOf<OpenTerm>();
expectTypeOf<RequirementsOf<typeof openDischarged>>().toEqualTypeOf<never>();
expectTypeOf<RequirementsOf<typeof addOp>>().toEqualTypeOf<AddEntry>();
expectTypeOf<RequirementsOf<typeof addDischarged>>().toEqualTypeOf<never>();

export const openRequired: Effect.Effect<
	Grant<OpenTerm>,
	RequiresLevel,
	CurrentActor | AgentAuthority | Kunye
> = OpenTerm.require;
export const addRequired: Effect.Effect<
	Grant<AddEntry>,
	RequiresLevel,
	CurrentActor | AgentAuthority | Kunye
> = AddEntry.require;
