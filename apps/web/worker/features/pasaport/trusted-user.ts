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
}

/**
 * The SELF trusted `User`: the subject's OWN tier (`Kunye.tierOf`, the stored
 * column, never the session field) + OWN moderator signal (`isModerator`, the
 * `moderates` tuple) stamped onto `toUser`. `me` and `setUsername` route through
 * here so their `User` shape can't drift.
 *
 * `emailFailing` (#2730) is the third self-only trusted field, but — unlike `tier`
 * and `isModerator`, which this home resolves — it is passed IN by the caller: it
 * projects off the `email_delivery_event` log (`Pasaport.readEmailFailing`), and
 * requiring `Pasaport` here would cycle (the mutation acks that call `toTrustedUser`
 * live inside the Pasaport service). The caller already holds `Pasaport`, so it
 * resolves the boolean and threads it through.
 */
export const toTrustedUser = (
	base: TrustedUserBase,
	emailFailing: boolean,
): Effect.Effect<User, never, Kunye | RelationStore> =>
	Effect.gen(function* () {
		const kunye = yield* Kunye;
		const tier = yield* kunye.tierOf(base.id);
		const isMod = yield* isModerator(base.id);
		return toUser({...base, tier, isModerator: isMod, emailFailing});
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
		// `emailFailing` is self-only (#2730): a by-id load is another account's row, so it
		// never carries that account's delivery state — always `false` on the batch path.
		return rows.map((row) => ({...row, isModerator: mods.has(row.id), emailFailing: false}));
	});
