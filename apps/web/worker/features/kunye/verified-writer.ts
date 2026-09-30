/**
 * The çaylak write gate (ADR 0434) — a capability-as-Effect (ADR 0107) over posting, commenting
 * and defining: a çaylak must have a verified email, a yazar passes. Tier and verification are
 * read fresh from {@link Kunye}, never from session state.
 *
 * It rides behind the default-off `phoenix-email-verified-writes` dark-ship flag (ADR 0083): the
 * `gateWriteOnVerifiedEmail` wrapper reads it, `requireVerifiedWriter` gates unconditionally.
 */
import {Capability, CurrentActor, Grant} from "@kampus/authz";
import {Effect} from "effect";
import {PHOENIX_EMAIL_VERIFIED_WRITES} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {EmailUnverified} from "./errors.ts";
import {Kunye} from "./Kunye.ts";
import type {Tier} from "./standing.ts";

const DENIAL = "Yazabilmek için önce e-posta adresini doğrulaman gerekiyor.";

/** Write a post, comment or definition — the right ADR 0434 gates on a verified email. */
export class CanWriteVerified extends Capability.Class<CanWriteVerified>()(
	"kunye/CanWriteVerified",
	{deny: () => new EmailUnverified({message: DENIAL})},
) {}

/**
 * The rule: a yazar was vouched or promoted, so it writes; a çaylak writes only verified; a
 * visitor (no account row) never writes.
 */
export const tierMayWrite = (tier: Tier, emailVerified: () => Effect.Effect<boolean>) => {
	switch (tier) {
		case "yazar":
			return Effect.succeed(true);
		case "çaylak":
			return emailVerified();
		case "visitor":
			return Effect.succeed(false);
	}
};

const currentActorMayWrite: Effect.Effect<boolean, never, CurrentActor | Kunye> = Effect.gen(
	function* () {
		const {actor} = yield* CurrentActor;
		if (actor._tag === "Unauthenticated") return false;
		const id = actor.principal.id;
		const kunye = yield* Kunye;
		const tier = yield* kunye.tierOf(id);
		return yield* tierMayWrite(tier, () => kunye.emailVerifiedOf(id));
	},
);

const discharge = <A, E, R>(enforce: boolean, body: Effect.Effect<A, E, CanWriteVerified | R>) =>
	Effect.gen(function* () {
		// Off mints the grant freely rather than skipping it, so the R channel stays sealed.
		const grant = yield* CanWriteVerified.authorize(
			enforce ? currentActorMayWrite : Effect.succeed(true),
		);
		return yield* body.pipe(Grant.provide(grant));
	});

/** Discharge {@link CanWriteVerified} into `body`; an unverified çaylak fails {@link EmailUnverified}. */
export const requireVerifiedWriter = <A, E, R>(body: Effect.Effect<A, E, CanWriteVerified | R>) =>
	discharge(true, body);

/**
 * The single `phoenix-email-verified-writes` read site. Safe-default `false`: a Flagship outage
 * degrades to gate-off, never a spurious denial.
 */
const verifiedWritesOn = Flags.pipe(
	Effect.flatMap((flags) =>
		flags.getBoolean(PHOENIX_EMAIL_VERIFIED_WRITES, false).pipe(provideRequestFlags),
	),
);

/** The dark-ship wrapper the gated mutations call: enforce only when the flag is on. */
export const gateWriteOnVerifiedEmail = <A, E, R>(
	body: Effect.Effect<A, E, CanWriteVerified | R>,
) => Effect.flatMap(verifiedWritesOn, (enforce) => discharge(enforce, body));
