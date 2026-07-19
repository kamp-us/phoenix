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
import {PHOENIX_USER_BAN} from "../../../src/flags/keys.ts";
import {UserId} from "../../lib/ids.ts";
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
import {resolveMeUser} from "./trusted-user.ts";
import type {Contribution} from "./views.ts";
import {AuthorshipStandingView, BanStateView, ProfileView, UserView} from "./views.ts";

const CONTRIBUTIONS_PAGE_SIZE = 20;

/** Is the #970 user-ban dark-ship flag on for this request? Safe-default `false` (dark). */
const userBanOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_BAN, false).pipe(provideRequestFlags);
});

const BanStateArgs = Schema.Struct({
	userId: UserId,
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
		// The current user, resolved through the shared {@link resolveMeUser} seam (ADR 0185):
		// the canonical row read fresh (so a just-set `username` round-trips before better-auth's
		// session inference), the SELF failing-delivery signal (#2693), and the trusted tier +
		// moderator standing — the SAME resolution the edge `__BOOT__.user` injection reuses.
		Effect.fn("me")(function* () {
			const user = yield* CurrentUser.required;
			return yield* resolveMeUser(user);
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
	// It is additive and does NOT relax `requireDivanAccess` — a çaylak still cannot
	// read `divan.roster`/`divan.backlog`.
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
const banStateGated = Effect.fn("user.banStateGated")(function* (userId: UserId) {
	yield* Admin;
	const pasaport = yield* Pasaport;
	return toBanState(userId, yield* pasaport.getBanState(userId));
});
