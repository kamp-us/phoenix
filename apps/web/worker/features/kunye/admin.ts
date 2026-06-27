/**
 * `Admin` — the platform-administration capability (ADR 0107 §4), the `admin`
 * sibling of {@link Moderate} on the `Relation` axis. `Admin.over(platform)`
 * discharges to a `Grant` iff the actor holds `(actor, "admin", platform)` (or an
 * ancestor) in the `relation_tuple` store (`RelationStoreLive`), checked fresh per
 * call. Admin authority is this ONE relation-backed capability — never better-auth's
 * AC model: ADR 0107 supersedes ADR 0102's better-auth-AC authorization substrate
 * (better-auth stays for authn + the user-management UI). See ADR 0107.
 *
 * Denial is the künye {@link Denied} (`UNAUTHORIZED`), so a non-admin cannot
 * distinguish "not an admin" from "not signed in" (the invisible-denial invariant,
 * ADR 0098 §2 carried forward). The instance lives here — künye owns the kamp.us
 * capability instances; the vocab-free mechanism is `@kampus/authz`. Tuples are
 * minted offline (`@kampus/admin-grant`), never by a runtime worker route.
 */
import {Capability, type Grant, matchActor, platform} from "@kampus/authz";
import {Effect} from "effect";
import {Denied} from "./errors.ts";

export class Admin extends Capability.Relation<Admin>()("kunye/Admin", {
	relation: "admin",
	deny: () => new Denied({message: "Admin authority required"}),
}) {}

// Re-export the platform scope so an admin surface gates with one import.
export {platform};

/**
 * Gate `body` behind platform-admin authority: discharge `Admin.over(platform)`
 * (the invisible {@link Denied} on failure) and thread the resulting `Grant` into
 * `body`'s R-channel via `Admin.provide`. So `body` can read `yield* Admin` for the
 * authority-checked admin identity, and "running an admin op without a `Grant`" is a
 * compile error — the proof is required by R, not a forgeable field (ADR 0107 §3).
 */
export const requireAdmin = <A, E, R>(body: Effect.Effect<A, E, Admin | R>) =>
	Admin.over(platform).pipe(Effect.flatMap((grant) => body.pipe(Admin.provide(grant))));

/**
 * The admin's account id from a discharged `Admin` grant — the authority-checked
 * identity an admin write stamps. A discharged grant is never anonymous
 * (`Admin.over` fails `Denied` on the `Unauthenticated` arm before minting), so the
 * anonymous arm is unreachable and dies as the defect it would be.
 */
export const adminOf = (grant: Grant<Admin>): Effect.Effect<string> =>
	matchActor(grant.actor, {
		onUnauthenticated: () =>
			Effect.die(
				new Error("Admin grant carried an unauthenticated actor — Admin.over denies anonymous"),
			),
		onHuman: (subject) => Effect.succeed(subject.id),
		onAgent: (acting) => Effect.succeed(acting.id),
	});
