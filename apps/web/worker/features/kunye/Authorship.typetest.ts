/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): an op that
 * declares `OpenTerm` / `AddEntry` in its requirements channel **fails to
 * compile** unless the matching `Grant` is provided via `Grant.provide` (ADR 0107
 * §1, the "forgot to authorize is a compile error" guarantee). Falsifiable by
 * reading the R channel — omit `Grant.provide` and the capability stays required;
 * provide it and R collapses to `never`. Mirrors `packages/authz`'s
 * `Capability.typetest.ts`, here over the real künye instances.
 */
import {type AgentAuthority, type CurrentActor, Grant} from "@kampus/authz";
import {Effect} from "effect";
import {expectTypeOf} from "vitest";
import {AddEntry, OpenTerm} from "./Authorship.ts";
import type {RequiresLevel} from "./errors.ts";
import type {Kunye} from "./Kunye.ts";

/** The requirements (R) channel of an effect type. */
type RequirementsOf<T> = [T] extends [Effect.Effect<unknown, unknown, infer R>] ? R : never;

declare const openTermGrant: Grant<OpenTerm>;
declare const addEntryGrant: Grant<AddEntry>;

/** An op that opens a başlık declares the `OpenTerm` proof and reads it back. */
const openOp: Effect.Effect<string, never, OpenTerm> = Effect.gen(function* () {
	const proof = yield* OpenTerm;
	return proof.scope.capability;
});

/** An op that adds an entry declares the `AddEntry` proof. */
const addOp: Effect.Effect<string, never, AddEntry> = Effect.gen(function* () {
	const proof = yield* AddEntry;
	return proof.scope.capability;
});

/** Providing each proof discharges its requirement — R collapses to `never`. */
export const openDischarged: Effect.Effect<string, never, never> = openOp.pipe(
	Grant.provide(openTermGrant),
);
export const addDischarged: Effect.Effect<string, never, never> = addOp.pipe(
	Grant.provide(addEntryGrant),
);

// Omit `Grant.provide` → the capability stays required in R; provide it → R is `never`.
expectTypeOf<RequirementsOf<typeof openOp>>().toEqualTypeOf<OpenTerm>();
expectTypeOf<RequirementsOf<typeof openDischarged>>().toEqualTypeOf<never>();
expectTypeOf<RequirementsOf<typeof addOp>>().toEqualTypeOf<AddEntry>();
expectTypeOf<RequirementsOf<typeof addDischarged>>().toEqualTypeOf<never>();

/** Each discharge verb requires the ports + standing read, never the proof it mints. */
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
