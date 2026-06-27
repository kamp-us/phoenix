/**
 * `Kunye` — the GLOBAL account-level earned-standing service (ADR 0107 §4): an
 * account's authorship `tier` on the `visitor < çaylak < yazar` ladder, its
 * `karma`, and the agent-attenuation `root` seam. Standing is read **fresh at
 * the point of use** from the pasaport karma surface (`user_profile.total_karma`,
 * ADR 0050), never trusted from session state — the "richer reads behind a
 * domain service" rule, so a `CurrentUserInfo` carrying only id/email/name/image
 * cannot smuggle a stale rank.
 *
 * It is the read side the `Capability.Level` instances (#1235's `Authorship`)
 * discharge against: their `read: (principal) => Effect<rank>` thunk is
 * {@link Kunye.tierOf} keyed by the principal's account id.
 */
import {Context, Effect, Layer} from "effect";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {type Tier, tierForKarma} from "./standing.ts";

export {authorshipLadder, KARMA_THRESHOLDS, type Tier, tierForKarma} from "./standing.ts";

export class Kunye extends Context.Service<
	Kunye,
	{
		/** The account's authorship rank on the `visitor < çaylak < yazar` ladder. */
		readonly tierOf: (id: string) => Effect.Effect<Tier>;
		/** The account's earned karma (`user_profile.total_karma`; 0 when no profile row). */
		readonly karmaOf: (id: string) => Effect.Effect<number>;
		/**
		 * The human root an account's authority attenuates to. **v1 is humans-only**,
		 * so an account's root is itself; v1.1 resolves an agent id to its human root
		 * through the agent registry, with no edit to this signature (the dormant seam).
		 */
		readonly rootOf: (id: string) => Effect.Effect<string>;
	}
>()("kunye/Kunye") {}

export const KunyeLive = Layer.effect(Kunye)(
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;

		const karmaOf = Effect.fn("Kunye.karmaOf")(function* (id: string) {
			const profile = yield* pasaport.lookupProfileById(id);
			return profile?.totalKarma ?? 0;
		});

		return {
			karmaOf,
			tierOf: (id) => Effect.map(karmaOf(id), tierForKarma),
			rootOf: (id) => Effect.succeed(id),
		};
	}),
);
