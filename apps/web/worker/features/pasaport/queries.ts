/**
 * Pasaport's root query resolvers (see .patterns/fate-effect-operations.md). They
 * return shaped output directly rather than masking through a source, so each
 * resolver builds the selected wire shape itself, nested connections included.
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
		// Shared with the edge `__BOOT__.user` injection (ADR 0185). The row is read fresh
		// so a just-set `username` round-trips before better-auth infers it.
		Effect.fn("me")(function* () {
			const user = yield* CurrentUser.required;
			return yield* resolveMeUser(user);
		}),
	),
	// `contributions` is delivered inline rather than through a source `connection`
	// capability, because the native path doesn't auto-invoke a hand-built source's
	// nested connection. See .patterns/fate-connections.md.
	profile: Fate.query(
		{args: ProfileArgs, type: ProfileView},
		Effect.fn("profile")(function* ({args, select}) {
			const pasaport = yield* Pasaport;
			// The SAME viewer must thread into both the headline counts and the
			// contribution feed, or the header disagrees with the feed for that viewer
			// (#1309/#1312). Only the author and a moderator see sandboxed content.
			const sandboxViewer = yield* currentSandboxViewer;
			const row = yield* pasaport.lookupProfile(args.username, {sandboxViewer});
			if (!row) return null;

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
	// The subject is always the authenticated reader and there is no input arg, so
	// reading another user's standing is unrepresentable. The one-way glass is
	// structural too: the view carries no identity field, only a bare `vouchExists`
	// boolean (never who vouched) and a bare count (never which items, or who is
	// reviewing them).
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

	// With the dark-ship flag off this fails the same invisible `Denied` a non-admin
	// call gets, so the read leaks no ban-state before release (#970).
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

// `yield* Admin` requires the grant proof in R, so reading an account's ban-state
// without a discharged grant is a compile error (ADR 0107).
const banStateGated = Effect.fn("user.banStateGated")(function* (userId: UserId) {
	yield* Admin;
	const pasaport = yield* Pasaport;
	return toBanState(userId, yield* pasaport.getBanState(userId));
});
