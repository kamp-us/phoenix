/**
 * Pasaport root query resolvers — `me`, `profile(username)`,
 * `myAuthorshipStanding`. `Fate.query` def + `Effect.fn` pairs
 * (`.patterns/fate-effect-operations.md`); they return shaped output directly (not
 * masked through a source), so the resolver builds the selected wire shape including
 * nested connections.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {hasNestedSelection} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_AUTHORSHIP_LOOP, PHOENIX_USER_BAN} from "../../../src/flags/keys.ts";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {promotionBarFor} from "../kunye/standing.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {Pasaport} from "./Pasaport.ts";
import {toAuthorshipStanding, toBanState, toContributionRow, toProfile} from "./shapers.ts";
import {toTrustedUser} from "./trusted-user.ts";
import type {Contribution} from "./views.ts";
import {AuthorshipStandingView, BanStateView, ProfileView, UserView} from "./views.ts";

const CONTRIBUTIONS_PAGE_SIZE = 20;

/** Is the earned-authorship loop on for this request? Safe-default `false` (dark). */
const loopOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_AUTHORSHIP_LOOP, false).pipe(provideRequestFlags);
});

/** Is the #970 user-ban dark-ship flag on for this request? Safe-default `false` (dark). */
const userBanOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_BAN, false).pipe(provideRequestFlags);
});

const BanStateArgs = Schema.Struct({
	userId: Schema.String,
});

// Nested connection args are scoped under the field path
// (`args.contributions.{first,after}`), matching fate's `getScopedArgs`.
const ProfileArgs = Schema.Struct({
	username: Schema.String,
	contributions: connectionArgs(),
});

export const queries = {
	me: Fate.query(
		{type: UserView, error: Unauthorized},
		// Reads the canonical row (not the session) so a fresh `username`
		// round-trips right after `setUsername` — better-auth's session inference
		// lags. Falls back to the session user when the row isn't found.
		Effect.fn("me")(function* () {
			const user = yield* CurrentUser.required;
			const pasaport = yield* Pasaport;
			const fresh = yield* pasaport.getUserById(user.id);
			// `toTrustedUser` resolves the trusted standing (tier via `Kunye.tierOf`,
			// the moderator signal via the `moderates` tuple) — one shared home for the
			// `User` shape `setUsername` and the by-id loader also build. The session
			// supplies email/name/image; the canonical row, when present, overrides them
			// so a fresh `username` round-trips before better-auth's session catches up.
			if (!fresh) {
				return yield* toTrustedUser({
					id: user.id,
					email: user.email,
					name: user.name ?? null,
					image: user.image ?? null,
					username: null,
				});
			}
			return yield* toTrustedUser({
				id: fresh.id,
				email: fresh.email,
				name: fresh.name,
				image: fresh.image,
				username: fresh.username,
			});
		}),
	),
	// `contributions` is delivered inline (not via a source `connection`
	// capability) because the native path doesn't auto-invoke a hand-built
	// source's nested `connection` (see fate-connections.md). Returns `null` for
	// an unknown username; the SPA renders its 404.
	profile: Fate.query(
		{args: ProfileArgs, type: ProfileView},
		Effect.fn("profile")(function* ({args, select}) {
			const pasaport = yield* Pasaport;
			// Resolve the sandbox viewer once (identity + moderator probe) and thread
			// the SAME viewer into BOTH the headline counts (`lookupProfile` ->
			// `hydrateProfile`, #1312) and the contribution feed (#1309), so a visitor
			// never sees this author's sandboxed content and the header counts agree
			// with the feed for that viewer. Only the author + a moderator see the full
			// (live + sandboxed) counts.
			const sandboxViewer = yield* currentSandboxViewer;
			const row = yield* pasaport.lookupProfile(args.username, {sandboxViewer});
			if (!row) return null;

			// `id` === `userId` is stamped once, in `toProfile`.
			const base = toProfile(row);

			if (!hasNestedSelection(select, "contributions")) {
				return base;
			}

			const connection = yield* pasaport.listContributions({
				authorId: row.userId,
				sandboxViewer,
				...keysetInput(args.contributions, CONTRIBUTIONS_PAGE_SIZE),
			});
			const contributions = toConnection<(typeof connection.rows)[number], Contribution>(
				connection,
				(edge) => edge.cursor,
				(edge) => ({__typename: "Contribution", ...toContributionRow(edge.node)}),
			);

			return {...base, contributions};
		}),
	),
	// The çaylak-SELF "yazarlığa giden yol" aggregate (#1316, epic #1202) — the
	// read the #1291 status block consumes. The subject is ALWAYS the authenticated
	// reader (`CurrentUser.required`, no input arg), so it can only ever describe the
	// reader's own standing — reading another user's self-status is unrepresentable.
	//
	// Dark-ship: behind `PHOENIX_AUTHORSHIP_LOOP`, off ⇒ `null` (not exposed). It is
	// additive and does NOT relax `requireDivanAccess` — a çaylak still cannot read
	// `divan.roster`/`divan.backlog`.
	//
	// One-way-glass is structural (`AuthorshipStanding` carries no identity field):
	// `vouchExists` is a bare boolean off `VouchLedger.hasActiveFor` (never WHO
	// vouched), `inReviewCount` a bare count off `Pasaport.countInReview` (never which
	// items / who is reviewing), `bar` the vouch-aware promotion bar so the frontend
	// never hardcodes it.
	myAuthorshipStanding: Fate.query(
		{type: AuthorshipStandingView, error: Unauthorized},
		Effect.fn("myAuthorshipStanding")(function* () {
			const user = yield* CurrentUser.required;
			if (!(yield* loopOn)) return null;

			const kunye = yield* Kunye;
			const ledger = yield* VouchLedger;
			const pasaport = yield* Pasaport;

			const karma = yield* kunye.karmaOf(user.id);
			const vouchExists = yield* ledger.hasActiveFor(user.id);
			const inReviewCount = yield* pasaport.countInReview(user.id);

			return toAuthorshipStanding({
				userId: user.id,
				karma,
				bar: promotionBarFor(vouchExists),
				vouchExists,
				inReviewCount,
			});
		}),
	),

	// The admin ban-state read (#970, epic #968) — `requireAdmin`-gated, behind the
	// `phoenix-user-ban` dark-ship flag. The moderator UI reads it to show whether the
	// focused actor is banned + the reason. With the flag off it fails the invisible
	// `Denied` (like a non-admin call), so the read never leaks ban-state until release.
	"user.banState": Fate.query(
		{args: BanStateArgs, type: BanStateView, error: Schema.Union([Denied])},
		Effect.fn("user.banState")(function* ({args}) {
			if (!(yield* userBanOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(banStateGated(args.userId));
		}),
	),
};

// The post-gate ban-state read — runnable only with an `Admin` `Grant` in R
// (`requireAdmin` provides it); `yield* Admin` requires the proof, so reading an
// account's ban-state without a discharged grant is a compile error (ADR 0107).
const banStateGated = Effect.fn("user.banStateGated")(function* (userId: string) {
	yield* Admin;
	const pasaport = yield* Pasaport;
	return toBanState(userId, yield* pasaport.getBanState(userId));
});
