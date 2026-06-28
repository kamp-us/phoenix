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
import {PHOENIX_AUTHORSHIP_LOOP} from "../../../src/flags/keys.ts";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {isModerator} from "../kunye/moderate.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {promotionBarFor} from "../kunye/standing.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {Pasaport} from "./Pasaport.ts";
import {toAuthorshipStanding, toContributionRow, toProfile, toUser} from "./shapers.ts";
import type {Contribution} from "./views.ts";
import {AuthorshipStandingView, ProfileView, UserView} from "./views.ts";

const CONTRIBUTIONS_PAGE_SIZE = 20;

/** Is the earned-authorship loop on for this request? Safe-default `false` (dark). */
const loopOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_AUTHORSHIP_LOOP, false).pipe(provideRequestFlags);
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
			const kunye = yield* Kunye;
			// The TRUSTED authorship rank: read fresh from the stored `user.tier`
			// column through `Kunye.tierOf`, never the `input:false` session field
			// (#1297). A row-missing principal ranks `visitor`, so this also covers
			// the fallback branch below.
			const tier = yield* kunye.tierOf(user.id);
			// The SELF moderator signal (#1320): server-authoritative off the `moderates`
			// relation tuple, keyed on the CURRENT user — the viewer's own status, never
			// another's. Fills `isModerator` identically to the `setUsername` write path.
			const isMod = yield* isModerator(user.id);
			const fresh = yield* pasaport.getUserById(user.id);
			if (!fresh) {
				return toUser({
					id: user.id,
					email: user.email,
					name: user.name ?? null,
					image: user.image ?? null,
					username: null,
					tier,
					isModerator: isMod,
				});
			}
			return toUser({...fresh, tier, isModerator: isMod});
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
};
