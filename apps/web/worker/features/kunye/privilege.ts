/**
 * Karma-VALUE privilege gates (#150, künye epic #41) — the capability-as-Effect
 * instances (ADR 0107) that floor a right on the actor's earned `total_karma`,
 * read fresh from {@link Kunye.karmaOf} (the #149 D1-direct write-path source of
 * truth, ADR 0050). Two rights:
 *
 *   - {@link CanPost}  — create content (post / comment / definition), floor ≥ −4.
 *   - {@link CanFlag}  — file a report (`report.submit`), floor ≥ 50.
 *
 * **A separate axis from the çaylak→yazar tier ladder and from ADR 0098
 * moderation — no double-gating (#150 rescope, 2026-07-02).** The `Authorship`
 * `Level` capabilities floor the authorship *tier* (an ordered rank); these floor
 * a raw karma *count*, an anti-abuse bar (a poster downvoted below −4 is muted; a
 * reporter needs 50 earned karma to flag). The two never gate the same fact, so
 * wiring a karma floor onto a mutation that already tier-gates is additive, not a
 * second check of one thing.
 *
 * Both are generic `Capability.Class` rights (not `Level`): karma is a continuous
 * integer, not a named ladder rank, so the floor is a numeric comparison the
 * `.authorize` check runs — the divan `ViewDivan` shape (`features/divan/gate.ts`),
 * here over a karma read. The richer {@link InsufficientKarma} (carrying the live
 * `have` + the `need` floor) is failed by the helper BEFORE the mint, so the
 * surface can name the bar; the class's own generic `deny()` is the unreachable
 * fallback the R-channel seal still requires.
 *
 * The gates ride behind the default-off `phoenix-karma-gates` flag: the mutation
 * decides whether to run the gate (with the flag off the karma read never runs and
 * the write behaves exactly as today — dark-ship, ADR 0083). These helpers gate
 * unconditionally; the flag check lives at the callsite.
 */
import {Capability, CurrentActor, Grant, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {PHOENIX_KARMA_GATES} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {InsufficientKarma} from "./errors.ts";
import {Kunye} from "./Kunye.ts";

/**
 * The v1 karma floors (#150 brief, reconciled 2026-07-02). Named constants, not
 * magic numbers at the check site — a floor move is a one-token edit here that
 * carries into both the gate and its `InsufficientKarma.need` field.
 *
 * - `post: -4` — content creation is muted only once an author is downvoted well
 *   below zero (an anti-abuse floor, deliberately negative so a fresh 0-karma
 *   account posts freely).
 * - `flag: 50` — filing a report is an earned privilege (anti-spam-report), so a
 *   flagger must have accrued real standing.
 */
export const KARMA_FLOORS = {post: -4, flag: 50} as const;

const POST_DENIAL = "İçerik paylaşmak için karman çok düşük.";
const FLAG_DENIAL = "Şikayet etmek için yeterli karman yok.";

/** Read a principal's earned `total_karma` off the {@link Kunye} standing service. */
const karmaOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.karmaOf(principal.id));

/**
 * Create content (pano post/comment, sözlük definition) — floored at
 * `KARMA_FLOORS.post` earned karma. A `Capability.Class`: the karma read + numeric
 * floor is the gate the helper runs (see {@link requireCanPost}); the generic
 * `deny()` is the unreachable fallback (the helper fails the richer
 * {@link InsufficientKarma} first).
 */
export class CanPost extends Capability.Class<CanPost>()("kunye/CanPost", {
	deny: () =>
		new InsufficientKarma({message: POST_DENIAL, need: KARMA_FLOORS.post, have: KARMA_FLOORS.post}),
}) {}

/**
 * File a report (`report.submit`, the ADR 0098 flagging surface) — floored at
 * `KARMA_FLOORS.flag` earned karma. Same `Capability.Class` shape as
 * {@link CanPost}; the floor differs.
 */
export class CanFlag extends Capability.Class<CanFlag>()("kunye/CanFlag", {
	deny: () =>
		new InsufficientKarma({message: FLAG_DENIAL, need: KARMA_FLOORS.flag, have: KARMA_FLOORS.flag}),
}) {}

/**
 * The current actor's earned karma, or `null` when there is no authenticated
 * principal. Reads `CurrentActor` for the principal and {@link Kunye.karmaOf} for
 * its live count — the fresh-read rule (never trust a stale session value).
 */
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
 * The floor decision for a karma-gated right: `check === true` ⇒ enforce the
 * numeric floor against the fresh karma read; `check === false` ⇒ auto-pass
 * (mint unconditionally, no karma read). The auto-pass arm is what keeps the
 * enforcement-by-R property (ADR 0107 §3) TRUE even with the gate dark — the
 * proof `body`'s R channel requires is ALWAYS minted, so `body`'s requirement
 * collapses whether the flag is on or off. A flag-off request is not "skip the
 * check"; it is "grant the right freely" — the same R shape, a different policy.
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

/**
 * Discharge {@link CanPost} and thread its `Grant` into `body`'s R channel — the
 * shape of `requireModeration` / `requireDivanAccess`, here over a numeric karma
 * floor read fresh from {@link Kunye}. On a below-floor read the richer
 * {@link InsufficientKarma} (`INSUFFICIENT_KARMA`, carrying `need = -4` and the
 * live `have`) is failed here, so the wire error names the actual gap; on a pass
 * `CanPost.authorize` mints the proof the R channel requires (a gated `body` that
 * forgets the check is a compile error, ADR 0107 §3).
 */
export const requireCanPost = <A, E, R>(body: Effect.Effect<A, E, CanPost | R>) =>
	dischargeKarma((c) => CanPost.authorize(c), KARMA_FLOORS.post, POST_DENIAL, true, body);

/**
 * Discharge {@link CanFlag} and thread its `Grant` into `body`'s R channel — the
 * flag-floor twin of {@link requireCanPost}. Fails the visible
 * {@link InsufficientKarma} (`need = 50`, live `have`) below the floor.
 */
export const requireCanFlag = <A, E, R>(body: Effect.Effect<A, E, CanFlag | R>) =>
	dischargeKarma((c) => CanFlag.authorize(c), KARMA_FLOORS.flag, FLAG_DENIAL, true, body);

/**
 * Is the `phoenix-karma-gates` dark-ship flag on for this request? Read fresh from
 * {@link Flags} with the safe-default `false` — a Flagship outage degrades to
 * gates-OFF (today's behavior), never a spurious denial. The single flag-read
 * site the flag-aware helpers below share so the key can't drift.
 */
const karmaGatesOn = Flags.pipe(
	Effect.flatMap((flags) => flags.getBoolean(PHOENIX_KARMA_GATES, false).pipe(provideRequestFlags)),
);

/**
 * The dark-ship wrapper for the post-floor gate: enforce {@link CanPost}'s karma
 * floor only when `phoenix-karma-gates` is on, else auto-pass (mint freely, no
 * karma read — today's behavior). The one-line callsite the content-creation
 * mutations (`post.submit`, `comment.add`, `definition.add`) use. The `CanPost`
 * grant is minted either way, so `body`'s R still collapses (enforcement-by-R
 * holds with the gate dark).
 */
export const gateContentOnKarma = <A, E, R>(body: Effect.Effect<A, E, CanPost | R>) =>
	Effect.flatMap(karmaGatesOn, (enforce) =>
		dischargeKarma((c) => CanPost.authorize(c), KARMA_FLOORS.post, POST_DENIAL, enforce, body),
	);

/**
 * The dark-ship wrapper for the flag-floor gate: the {@link gateContentOnKarma}
 * twin over {@link CanFlag}, used by `report.submit`.
 */
export const gateFlagOnKarma = <A, E, R>(body: Effect.Effect<A, E, CanFlag | R>) =>
	Effect.flatMap(karmaGatesOn, (enforce) =>
		dischargeKarma((c) => CanFlag.authorize(c), KARMA_FLOORS.flag, FLAG_DENIAL, enforce, body),
	);
