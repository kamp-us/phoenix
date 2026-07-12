/**
 * `Vouch` — the author-vouch capability (ADR 0107 §2-3, #1206). A `Capability.Level`
 * floored at `yazar`, the per-RIGHT sibling of {@link ../kunye/Authorship.ts | OpenTerm}:
 * vouching for a çaylak's promotion is its OWN right (capabilities are named by what
 * they authorize, ADR 0107 §2) even though it shares OpenTerm's yazar floor — a vouch
 * is not opening a term. `Vouch.require` discharges to a `Grant` iff the actor's GLOBAL
 * account standing (read fresh via {@link Kunye.tierOf}) is `gte yazar`; a çaylak,
 * visitor, or anonymous actor fails the public {@link RequiresLevel} (`FORBIDDEN`),
 * carrying the needed rank so the ladder stays a visible progression.
 *
 * Modeling the vouch authority THROUGH the framework (not an ad-hoc `if (tier===yazar)`)
 * is what makes self-promotion structurally impossible: a çaylak cannot discharge
 * `Vouch` (below the floor) and cannot discharge {@link ../kunye/moderate.ts | Moderate}
 * (no tuple), and a yazar "promoting themselves" is a no-op (already yazar). The two
 * authority paths are the only triggers, both gated by the framework.
 */
import {Capability, Grant, matchActor, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {UserId} from "../../lib/ids.ts";
import {RequiresLevel} from "./errors.ts";
import {authorshipLadder, Kunye} from "./Kunye.ts";

/** Read a principal's global account-level rank off the {@link Kunye} standing service. */
const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

/** Vouch for a çaylak's promotion to yazar — requires `yazar` earned standing. */
export class Vouch extends Capability.Level<Vouch>()("kunye/Vouch", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Kefil olmak için yazar olmalısın.", need: "yazar"}),
}) {}

/**
 * Gate `body` behind yazar standing: discharge `Vouch.require` (the public
 * {@link RequiresLevel} on failure) and thread the resulting `Grant` into `body`'s
 * R-channel via `Grant.provide`. So `body` can read `yield* Vouch` for the
 * authority-checked voucher identity, and "vouching without a `Grant`" is a compile
 * error — the proof is required by R, not a forgeable field (ADR 0107 §3). Mirrors
 * {@link ../kunye/moderate.ts | requireModeration}.
 */
export const requireVouch = <A, E, R>(body: Effect.Effect<A, E, Vouch | R>) =>
	Vouch.require.pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));

/**
 * The voucher's account id from a discharged `Vouch` grant — the vouching actor the
 * vouch record preserves, minted as the shared branded {@link UserId} (see
 * `lib/ids.ts`). A discharged grant is never anonymous (`Vouch.require` fails on the
 * `Unauthenticated` arm before minting), so the anonymous arm is unreachable and
 * dies as the defect it would be.
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
