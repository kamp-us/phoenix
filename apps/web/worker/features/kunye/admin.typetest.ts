/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): an admin-gated op that
 * declares `Admin` in its requirements channel fails to compile unless the matching `Grant`
 * is provided (ADR 0107 §1). Falsifiable by reading the R channel: omit `Grant.provide` and
 * the capability stays required; provide it and R collapses to the discharge ports.
 */
import {type AgentAuthority, type CurrentActor, Grant, type RelationStore} from "@kampus/authz";
import {Effect} from "effect";
import {expectTypeOf} from "vitest";
import {Admin, platform, requireAdmin} from "./admin.ts";
import type {Denied} from "./errors.ts";

type RequirementsOf<T> = [T] extends [Effect.Effect<unknown, unknown, infer R>] ? R : never;

declare const adminGrant: Grant<Admin>;

const adminOp: Effect.Effect<string, never, Admin> = Effect.gen(function* () {
	const proof = yield* Admin;
	return proof.scope.capability;
});

export const adminDischarged: Effect.Effect<string, never, never> = adminOp.pipe(
	Grant.provide(adminGrant),
);

expectTypeOf<RequirementsOf<typeof adminOp>>().toEqualTypeOf<Admin>();
expectTypeOf<RequirementsOf<typeof adminDischarged>>().toEqualTypeOf<never>();

export const adminGated: Effect.Effect<
	string,
	Denied,
	CurrentActor | RelationStore | AgentAuthority
> = requireAdmin(adminOp);

expectTypeOf<RequirementsOf<typeof adminGated>>().toEqualTypeOf<
	CurrentActor | RelationStore | AgentAuthority
>();

export const adminRequired: Effect.Effect<
	Grant<Admin>,
	Denied,
	CurrentActor | RelationStore | AgentAuthority
> = Admin.over(platform);
