/**
 * Trusted-`User` composition — the one home for "resolve the server-authoritative
 * standing (tier + moderator signal) and attach it". `me` and `user.setUsername`
 * stamp the wire `User` here through `toTrustedUser`; the by-id loader joins the same
 * moderator/tier standing via `getUsersWithModerationByIds` (its `UserView` masks the
 * row to `User`). So the masking decision (trusted reads vs the `input:false` session
 * fields, #1297/#1320) has a single source and a third trusted field is a one-site
 * change. The leaf record-stamper stays `toUser` (`shapers.ts`); this is the
 * read-then-attach layer above it, in the domain (ADR 0013), never inline in a fate
 * transport handler (ADR 0016).
 */
import type {RelationStore} from "@kampus/authz";
import {Effect} from "effect";
import {Kunye} from "../kunye/Kunye.ts";
import {isModerator, moderatorsAmong} from "../kunye/moderate.ts";
import {Pasaport} from "./Pasaport.ts";
import {toUser} from "./shapers.ts";
import type {User} from "./views.ts";

/** The non-standing fields of a `User` — id + the email-ish fields the session carries. */
export interface TrustedUserBase {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
	// The SELF failing-delivery signal (#2693). Only `queries.me` sets it (from #2691's
	// projection); every other caller omits it and `toTrustedUser` defaults it `false`, so a
	// non-self trusted `User` never carries real delivery-state (see `user-fields.ts`).
	emailFailing?: boolean;
}

/**
 * The SELF trusted `User`: the subject's OWN tier (`Kunye.tierOf`, the stored
 * column, never the session field) + OWN moderator signal (`isModerator`, the
 * `moderates` tuple) stamped onto `toUser`. `me` and `setUsername` route through
 * here so their `User` shape can't drift.
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

/** The validated session identity {@link resolveMeUser} resolves the trusted `User` from. */
export interface MeSessionUser {
	id: string;
	email: string;
	name?: string | null | undefined;
	image?: string | null | undefined;
}

/**
 * The ONE session→user resolution shared by the `/fate` `me` query and the edge
 * `__BOOT__.user` injection (ADR 0185), so both read the same canonical row + trusted
 * standing. Reads the canonical `user` row fresh (so a just-set `username` round-trips before
 * better-auth's session inference catches up), falling back to the session identity when the
 * row is absent; projects the SELF failing-delivery signal (#2693); then attaches the trusted
 * tier + moderator standing via {@link toTrustedUser}.
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
 * The BATCHED by-id user rows with moderator standing joined on: fetch the user
 * rows, then ONE `RelationStore` set-membership read (`moderatorsAmong`) decides
 * which of them moderate — no per-row `isModerator` call. Each row already carries
 * its stored `tier`, so the batch needs no per-row tier fetch. This is the domain
 * method `userSource.byIds` delegates to, restoring fate pure transport at the loader
 * (ADR 0016); the loader's `UserView` masks the row down to the wire `User`.
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
