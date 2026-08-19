/**
 * Karma-VALUE privilege gates — capabilities-as-Effect (ADR 0107) that floor a right
 * on the actor's earned `total_karma`, read fresh from {@link Kunye.karmaOf}.
 *
 * A separate axis from the çaylak→yazar tier ladder: `Authorship` `Level` floors an
 * ordered rank, these floor a raw count. The two never gate the same fact, so stacking
 * a karma floor onto a tier-gated mutation is additive, not double-gating.
 *
 * Both ride behind the default-off `phoenix-karma-gates` dark-ship flag (ADR 0083) —
 * the `gate*OnKarma` wrappers read it, the `require*` helpers gate unconditionally.
 */
import {Capability, CurrentActor, Grant, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {PHOENIX_KARMA_GATES} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {InsufficientKarma} from "./errors.ts";
import {Kunye} from "./Kunye.ts";

/**
 * The v1 karma floors.
 *
 * - `post: -4` — deliberately negative so a fresh 0-karma account posts freely; only
 *   an author downvoted well below zero is muted.
 * - `flag: 50` — filing a report is an earned privilege (anti-spam-report).
 */
export const KARMA_FLOORS = {post: -4, flag: 50} as const;

const POST_DENIAL = "İçerik paylaşmak için karman çok düşük.";
const FLAG_DENIAL = "Şikayet etmek için yeterli karman yok.";

const karmaOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.karmaOf(principal.id));

/**
 * Create content — floored at `KARMA_FLOORS.post`. The floor check runs in
 * {@link requireCanPost}, which fails the richer {@link InsufficientKarma} first, so
 * this generic `deny()` is an unreachable fallback the R-channel seal still requires.
 */
export class CanPost extends Capability.Class<CanPost>()("kunye/CanPost", {
	deny: () =>
		new InsufficientKarma({message: POST_DENIAL, need: KARMA_FLOORS.post, have: KARMA_FLOORS.post}),
}) {}

/** File a report — floored at `KARMA_FLOORS.flag`. Same shape as {@link CanPost}. */
export class CanFlag extends Capability.Class<CanFlag>()("kunye/CanFlag", {
	deny: () =>
		new InsufficientKarma({message: FLAG_DENIAL, need: KARMA_FLOORS.flag, have: KARMA_FLOORS.flag}),
}) {}

/** The current actor's karma, or `null` when unauthenticated. Always a fresh read — never a stale session value. */
const currentActorKarma: Effect.Effect<
	{principal: Principal; have: number} | null,
	never,
	CurrentActor | Kunye
> = Effect.gen(function* () {
	const {actor} = yield* CurrentActor;
	if (actor._tag === "Unauthenticated") return null;
	const {principal} = actor;
	const have = yield* karmaOf(principal);
	return {principal, have};
});

/**
 * The floor decision for a karma-gated right. `enforce === false` auto-passes by
 * minting the grant unconditionally — NOT "skip the check" but "grant the right
 * freely", which is what keeps enforcement-by-R (ADR 0107 §3) true with the gate dark.
 */
const dischargeKarma = <Self, A, E, R>(
	authorize: (
		check: Effect.Effect<boolean>,
	) => Effect.Effect<Grant<Self>, InsufficientKarma, CurrentActor>,
	need: number,
	denial: string,
	enforce: boolean,
	body: Effect.Effect<A, E, Self | R>,
) =>
	Effect.gen(function* () {
		if (enforce) {
			const read = yield* currentActorKarma;
			// An anonymous actor never reaches here (`CurrentUser.required` rejects it
			// at the mutation edge); the `null` arm denies fail-closed regardless.
			if (read === null || read.have < need) {
				return yield* new InsufficientKarma({message: denial, need, have: read?.have ?? 0});
			}
		}
		const grant = yield* authorize(Effect.succeed(true));
		return yield* body.pipe(Grant.provide(grant));
	});

/** Discharge {@link CanPost} into `body`'s R channel; below the floor fails {@link InsufficientKarma} naming the gap. */
export const requireCanPost = <A, E, R>(body: Effect.Effect<A, E, CanPost | R>) =>
	dischargeKarma((c) => CanPost.authorize(c), KARMA_FLOORS.post, POST_DENIAL, true, body);

/** The flag-floor twin of {@link requireCanPost}. */
export const requireCanFlag = <A, E, R>(body: Effect.Effect<A, E, CanFlag | R>) =>
	dischargeKarma((c) => CanFlag.authorize(c), KARMA_FLOORS.flag, FLAG_DENIAL, true, body);

/**
 * The single `phoenix-karma-gates` read site, so the key can't drift. Safe-default
 * `false`: a Flagship outage degrades to gates-OFF, never a spurious denial.
 */
const karmaGatesOn = Flags.pipe(
	Effect.flatMap((flags) => flags.getBoolean(PHOENIX_KARMA_GATES, false).pipe(provideRequestFlags)),
);

/**
 * The dark-ship wrapper content-creation mutations call: enforce {@link CanPost}'s
 * floor only when `phoenix-karma-gates` is on, else mint freely.
 */
export const gateContentOnKarma = <A, E, R>(body: Effect.Effect<A, E, CanPost | R>) =>
	Effect.flatMap(karmaGatesOn, (enforce) =>
		dischargeKarma((c) => CanPost.authorize(c), KARMA_FLOORS.post, POST_DENIAL, enforce, body),
	);

/** The {@link gateContentOnKarma} twin over {@link CanFlag}, used by `report.submit`. */
export const gateFlagOnKarma = <A, E, R>(body: Effect.Effect<A, E, CanFlag | R>) =>
	Effect.flatMap(karmaGatesOn, (enforce) =>
		dischargeKarma((c) => CanFlag.authorize(c), KARMA_FLOORS.flag, FLAG_DENIAL, enforce, body),
	);
