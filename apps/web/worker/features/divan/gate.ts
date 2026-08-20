/**
 * The divan access gate — the capability framework's first **disjunctive** gate (ADR
 * 0107): the right to view the çaylak proving ground is earned by EITHER yazar standing
 * OR platform-moderation authority.
 *
 * The OR is not an `if (tier === "yazar" || isMod)` bypass. {@link standsInDivan} runs
 * TWO real capability discharges — {@link DivanStanding} and `Moderate.over(platform)` —
 * each collapsed to a boolean and OR-ed, and {@link ViewDivan}`.authorize` mints one grant
 * from the result. The read requires that grant in its R channel (ADR 0107 §3), so a divan
 * read that forgets the gate is a compile error, not a forgotten `if`.
 *
 * Denial is the invisible {@link Denied}: the divan is a private destination, like the
 * moderation queue.
 */
import {Capability, Grant, type Principal, platform} from "@kampus/authz";
import {Effect} from "effect";
import {Denied, RequiresLevel} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {Moderate} from "../kunye/moderate.ts";
import {authorshipLadder} from "../kunye/standing.ts";

/** Read a principal's global account-level rank off the {@link Kunye} standing service. */
const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

/**
 * The divan's OWN yazar-standing right (ADR 0107 §2), so divan access no longer borrows
 * the sözlük `OpenTerm` write-path right as a yazar litmus and the two floors move
 * independently.
 */
export class DivanStanding extends Capability.Level<DivanStanding>()("divan/DivanStanding", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Divanda durmak için yazar olmalısın.", need: "yazar"}),
}) {}

/**
 * TRUE iff the actor discharges {@link DivanStanding} OR holds `Moderate.over(platform)`;
 * each arm's denial collapses to `false`.
 */
const standsInDivan = Effect.gen(function* () {
	const asYazar = yield* DivanStanding.require.pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);
	if (asYazar) return true;
	return yield* Moderate.over(platform).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);
});

/**
 * A generic `Capability.Class` because the right is a union of two heterogeneous proofs —
 * neither a single `Level` floor nor a single `Relation` can express the OR.
 */
export class ViewDivan extends Capability.Class<ViewDivan>()("divan/ViewDivan", {
	deny: () => new Denied({message: "Divanı görmek için yazar ya da moderatör olmalısın."}),
}) {}

/** Gate `body` behind divan access, threading the grant into its R channel. */
export const requireDivanAccess = <A, E, R>(body: Effect.Effect<A, E, ViewDivan | R>) =>
	ViewDivan.authorize(standsInDivan).pipe(
		Effect.flatMap((grant) => body.pipe(Grant.provide(grant))),
	);
