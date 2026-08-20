/**
 * `SetCaylakVisibility` — the yazar floor on opting INTO in-place çaylak visibility
 * (#6422, epic #4306), a `Capability.Level` modeled verbatim on {@link
 * ../mecmua/PublishMecmua PublishMecmua}: it reads the GLOBAL account-level standing
 * off {@link Kunye.tierOf} against the {@link authorshipLadder} and denies with
 * {@link RequiresLevel} (`FORBIDDEN`).
 *
 * The floor is load-bearing, not cosmetic. Without it the toggle becomes a
 * çaylak-to-çaylak visibility channel the moment someone calls the mutation directly,
 * which the epic names a no-go — so the tier is read fresh here, never taken from
 * request input or session state.
 *
 * Opting OUT is deliberately NOT behind this floor (the mecmua publish/saveDraft
 * split): an account that was a yazar when it opted in and is no longer one must
 * still be able to withdraw, and withdrawing grants nothing.
 */
import {Capability, Grant, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {RequiresLevel} from "../kunye/errors.ts";
import {authorshipLadder, Kunye} from "../kunye/Kunye.ts";

/** Read a principal's global account-level rank off the {@link Kunye} standing service. */
const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

export class SetCaylakVisibility extends Capability.Level<SetCaylakVisibility>()(
	"caylak-visibility/SetCaylakVisibility",
	{
		scale: authorshipLadder,
		min: "yazar",
		read: standingOf,
		deny: () =>
			new RequiresLevel({
				message: "Bu ayarı değiştirmek için yazar olmalısın.",
				need: "yazar",
			}),
	},
) {}

/**
 * Gate `body` behind {@link SetCaylakVisibility}: discharge the yazar floor and thread
 * the grant into `body`'s R channel, so opting in without the gate is a compile error
 * (enforcement-by-R, ADR 0107 §3).
 */
export const requireSetCaylakVisibility = <A, E, R>(
	body: Effect.Effect<A, E, SetCaylakVisibility | R>,
) => SetCaylakVisibility.require.pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));
