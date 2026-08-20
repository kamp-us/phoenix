/**
 * The account-level earned-standing service (ADR 0107 §4): authorship tier, karma,
 * and the agent-attenuation root seam. Standing is read fresh from pasaport at the
 * point of use and never trusted from session state, so a session user object cannot
 * smuggle a stale rank. It is the read side the `Capability.Level` instances
 * discharge against.
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
		// The rank on the `visitor < çaylak < yazar` ladder.
		readonly tierOf: (id: string) => Effect.Effect<Tier>;
		readonly karmaOf: (id: string) => Effect.Effect<number>;
		// The human root an account's authority attenuates to. v1 is humans-only, so an
		// account's root is itself; the signature is the dormant seam for agent ids.
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
			// No account row means `visitor`; an account carries its stored tier (#1203).
			tierOf: (id) => Effect.map(pasaport.getUserById(id), (user): Tier => user?.tier ?? "visitor"),
			rootOf: (id) => Effect.succeed(id),
		};
	}),
);
