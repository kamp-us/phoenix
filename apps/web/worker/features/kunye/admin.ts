/**
 * `Admin` — the platform-administration capability (ADR 0107 §4). Admin authority is this
 * ONE relation-backed capability, never better-auth's AC model (better-auth stays for
 * authn + the user-management UI).
 *
 * Denial is the künye {@link Denied} (`UNAUTHORIZED`), so a non-admin cannot distinguish
 * "not an admin" from "not signed in" (the invisible-denial invariant, ADR 0098 §2).
 * Tuples are minted offline (`@kampus/admin-grant`), never by a runtime worker route.
 */
import {Capability, Grant, matchActor, platform} from "@kampus/authz";
import {Effect} from "effect";
import {UserId} from "../../lib/ids.ts";
import {Denied} from "./errors.ts";

export class Admin extends Capability.Relation<Admin>()("kunye/Admin", {
	relation: "admin",
	deny: () => new Denied({message: "Admin authority required"}),
}) {}

// Re-export the platform scope so an admin surface gates with one import.
export {platform};

/**
 * Threads the discharged `Grant` into `body`'s R-channel, so "running an admin op without
 * a `Grant`" is a compile error — the proof is required by R, not a forgeable field
 * (ADR 0107 §3).
 */
export const requireAdmin = <A, E, R>(body: Effect.Effect<A, E, Admin | R>) =>
	Admin.over(platform).pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));

/**
 * A discharged grant is never anonymous (`Admin.over` denies the `Unauthenticated` arm
 * first), so that arm is unreachable and dies as the defect it would be.
 */
export const adminOf = (grant: Grant<Admin>): Effect.Effect<UserId> =>
	matchActor(grant.actor, {
		onUnauthenticated: () =>
			Effect.die(
				new Error("Admin grant carried an unauthenticated actor — Admin.over denies anonymous"),
			),
		onHuman: (subject) => Effect.succeed(UserId.make(subject.id)),
		onAgent: (acting) => Effect.succeed(UserId.make(acting.id)),
	});
