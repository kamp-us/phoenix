/**
 * `Kunye` — the GLOBAL account-level earned-standing service (ADR 0107 §4): an
 * account's authorship `tier` on the `visitor < çaylak < yazar` ladder, its
 * `karma`, and the agent-attenuation `root` seam. Standing is read **fresh at
 * the point of use** from pasaport, never trusted from session state — the
 * "richer reads behind a domain service" rule, so a `CurrentUserInfo` carrying
 * only id/email/name/image cannot smuggle a stale rank.
 *
 * `tierOf` reads the **server-managed `user.tier` column** (#1203) — an
 * authenticated account is `≥ çaylak`, a no-account principal is `visitor`. (The
 * karma→tier derivation it once used is retired from this read; that math now
 * belongs to the promotion (#1206) / karma (#1208) children — see `standing.ts`.)
 *
 * It is the read side the `Capability.Level` instances (#1235's `Authorship`)
 * discharge against: their `read: (principal) => Effect<rank>` thunk is
 * {@link Kunye.tierOf} keyed by the principal's account id.
 */
import {Context, Effect, Layer} from "effect";
import {Pasaport} from "../pasaport/Pasaport.ts";
import type {Tier} from "./standing.ts";

export {
	authorshipLadder,
	KARMA_THRESHOLDS,
	STORED_TIERS,
	type StoredTier,
	type Tier,
	tierForKarma,
} from "./standing.ts";

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
			// The stored `user.tier` column read fresh through pasaport (#1203). No
			// account row ⇒ `visitor`; an account is its stored `çaylak | yazar`.
			tierOf: (id) => Effect.map(pasaport.getUserById(id), (user): Tier => user?.tier ?? "visitor"),
			rootOf: (id) => Effect.succeed(id),
		};
	}),
);
