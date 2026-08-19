/**
 * Trusted-`User` composition — the one home for "resolve the server-authoritative standing
 * (tier + moderator signal) and attach it", so the masking decision (trusted reads vs the
 * `input:false` session fields, #1297/#1320) has a single source. The leaf record-stamper stays
 * `toUser` (`shapers.ts`); this is the read-then-attach layer above it, in the domain (ADR 0013).
 */
import type {RelationStore} from "@kampus/authz";
import {Effect} from "effect";
import {Kunye} from "../kunye/Kunye.ts";
import {isModerator, moderatorsAmong} from "../kunye/moderate.ts";
import {Pasaport} from "./Pasaport.ts";
import {toUser} from "./shapers.ts";
import type {User} from "./views.ts";

export interface TrustedUserBase {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
	// The SELF failing-delivery signal (#2693): only `queries.me` sets it; every other caller omits
	// it and it defaults `false`, so a non-self trusted `User` never carries real delivery-state.
	emailFailing?: boolean;
}

/**
 * The SELF trusted `User`: the subject's OWN tier (the stored column, never the session field)
 * + OWN moderator signal stamped onto `toUser`.
 */
export const toTrustedUser = (
	base: TrustedUserBase,
): Effect.Effect<User, never, Kunye | RelationStore> =>
	Effect.gen(function* () {
		const kunye = yield* Kunye;
		const tier = yield* kunye.tierOf(base.id);
		const isMod = yield* isModerator(base.id);
		return toUser({...base, tier, isModerator: isMod, emailFailing: base.emailFailing ?? false});
	});

export interface MeSessionUser {
	id: string;
	email: string;
	name?: string | null | undefined;
	image?: string | null | undefined;
}

/**
 * The ONE session→user resolution shared by the `/fate` `me` query and the edge `__BOOT__.user`
 * injection (ADR 0185). The canonical row is read FRESH so a just-set `username` round-trips
 * before better-auth's session inference catches up; the session identity is the fallback.
 */
export const resolveMeUser = (
	sessionUser: MeSessionUser,
): Effect.Effect<User, never, Pasaport | Kunye | RelationStore> =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const fresh = yield* pasaport.getUserById(sessionUser.id);
		const base = fresh
			? {
					id: fresh.id,
					email: fresh.email,
					name: fresh.name,
					image: fresh.image,
					username: fresh.username,
				}
			: {
					id: sessionUser.id,
					email: sessionUser.email,
					name: sessionUser.name ?? null,
					image: sessionUser.image ?? null,
					username: null,
				};
		const emailFailing = yield* pasaport.getEmailDeliveryState(base.id).pipe(
			Effect.map((r) => r.state.failing),
			Effect.catchTag("pasaport/UserNotFound", () => Effect.succeed(false)),
		);
		return yield* toTrustedUser({...base, emailFailing});
	});

/**
 * The BATCHED by-id rows: ONE `RelationStore` set-membership read decides which of them
 * moderate — no per-row `isModerator` call, and no per-row tier fetch (each row carries its
 * stored `tier`). `userSource.byIds` delegates here, keeping fate transport pure (ADR 0016).
 */
export const getUsersWithModerationByIds = (ids: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const rows = yield* pasaport.getUsersByIds(ids);
		const mods = yield* moderatorsAmong(rows.map((row) => row.id));
		// `emailFailing` is a flat `false` on the by-id batch: it is the reader's OWN signal,
		// resolved only on the self `me` read (#2693), never another account's delivery-state.
		return rows.map((row) => ({...row, isModerator: mods.has(row.id), emailFailing: false}));
	});
