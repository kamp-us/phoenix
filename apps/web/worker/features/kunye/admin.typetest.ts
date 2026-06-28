/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): an admin-gated
 * op that declares `Admin` in its requirements channel **fails to compile** unless
 * the matching `Grant` is provided via `Grant.provide` (ADR 0107 §1, the "forgot to
 * authorize is a compile error" guarantee — acceptance criterion #2). Falsifiable by
 * reading the R channel — omit `Grant.provide` and the capability stays required; provide
 * it (or gate through `requireAdmin`) and R collapses, leaving only the discharge
 * ports. Mirrors `Authorship.typetest.ts`, here over the `Admin` instance.
 */
import {type AgentAuthority, type CurrentActor, Grant, type RelationStore} from "@kampus/authz";
import {Effect} from "effect";
import {expectTypeOf} from "vitest";
import {Admin, platform, requireAdmin} from "./admin.ts";
import type {Denied} from "./errors.ts";

/** The requirements (R) channel of an effect type. */
type RequirementsOf<T> = [T] extends [Effect.Effect<unknown, unknown, infer R>] ? R : never;

declare const adminGrant: Grant<Admin>;

/** An admin-gated op declares the `Admin` proof and reads it back. */
const adminOp: Effect.Effect<string, never, Admin> = Effect.gen(function* () {
	const proof = yield* Admin;
	return proof.scope.capability;
});

/** Providing the proof discharges its requirement — R collapses to `never`. */
export const adminDischarged: Effect.Effect<string, never, never> = adminOp.pipe(
	Grant.provide(adminGrant),
);

// Omit `Grant.provide` → `Admin` stays required in R; provide it → R is `never`.
expectTypeOf<RequirementsOf<typeof adminOp>>().toEqualTypeOf<Admin>();
expectTypeOf<RequirementsOf<typeof adminDischarged>>().toEqualTypeOf<never>();

/** `requireAdmin` discharges the gated op's `Admin`, leaving the discharge ports in R. */
export const adminGated: Effect.Effect<
	string,
	Denied,
	CurrentActor | RelationStore | AgentAuthority
> = requireAdmin(adminOp);

// The gate consumes `Admin` from R (it provides the minted proof itself) — the op's
// `Admin` requirement is gone, only the `.over` discharge ports remain.
expectTypeOf<RequirementsOf<typeof adminGated>>().toEqualTypeOf<
	CurrentActor | RelationStore | AgentAuthority
>();

/** The discharge verb requires the ports, never the proof it mints. */
export const adminRequired: Effect.Effect<
	Grant<Admin>,
	Denied,
	CurrentActor | RelationStore | AgentAuthority
> = Admin.over(platform);
