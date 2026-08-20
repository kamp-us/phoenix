/**
 * `Vouch` — the author-vouch capability (ADR 0107 §2-3, #1206). Its own right even
 * though it shares OpenTerm's yazar floor: capabilities are named by what they
 * authorize, and a vouch is not opening a term.
 *
 * Modeling the authority THROUGH the framework (not an ad-hoc `if (tier===yazar)`) is
 * what makes self-promotion structurally impossible: a çaylak can discharge neither
 * `Vouch` (below the floor) nor `Moderate` (no tuple), and a yazar promoting
 * themselves is a no-op.
 */
import {Capability, Grant, matchActor, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {UserId} from "../../lib/ids.ts";
import {RequiresLevel} from "./errors.ts";
import {authorshipLadder, Kunye} from "./Kunye.ts";

const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

export class Vouch extends Capability.Level<Vouch>()("kunye/Vouch", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Kefil olmak için yazar olmalısın.", need: "yazar"}),
}) {}

/**
 * Gate `body` behind yazar standing and thread the resulting `Grant` into `body`'s
 * R-channel, so "vouching without a `Grant`" is a compile error — the proof is
 * required by R, not a forgeable field (ADR 0107 §3).
 */
export const requireVouch = <A, E, R>(body: Effect.Effect<A, E, Vouch | R>) =>
	Vouch.require.pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));

/**
 * The voucher's account id from a discharged `Vouch` grant. A discharged grant is
 * never anonymous (`Vouch.require` fails on the `Unauthenticated` arm first), so the
 * anonymous arm is unreachable and dies as the defect it would be.
 */
export const voucherOf = (grant: Grant<Vouch>): Effect.Effect<UserId> =>
	matchActor(grant.actor, {
		onUnauthenticated: () =>
			Effect.die(
				new Error("Vouch grant carried an unauthenticated actor — Vouch.require denies anonymous"),
			),
		onHuman: (subject) => Effect.succeed(UserId.make(subject.id)),
		onAgent: (acting) => Effect.succeed(UserId.make(acting.id)),
	});
