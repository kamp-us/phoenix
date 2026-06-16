/**
 * Pasaport root query resolvers — `me`, `profile(username)`. `Fate.query` def +
 * `Effect.fn` pairs (`.patterns/fate-effect-operations.md`); they return shaped
 * output directly (not masked through a source), so the resolver builds the
 * selected wire shape including nested connections.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {hasNestedSelection} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Pasaport} from "./Pasaport.ts";
import {toContributionRow, toProfile, toUser} from "./shapers.ts";
import type {Contribution} from "./views.ts";
import {ProfileView, UserView} from "./views.ts";

const CONTRIBUTIONS_PAGE_SIZE = 20;

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
			if (!fresh) {
				return toUser({
					id: user.id,
					email: user.email,
					name: user.name ?? null,
					image: user.image ?? null,
					username: null,
				});
			}
			return toUser(fresh);
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
			const row = yield* pasaport.lookupProfile(args.username);
			if (!row) return null;

			// `id` === `userId` is stamped once, in `toProfile`.
			const base = toProfile(row);

			if (!hasNestedSelection(select, "contributions")) {
				return base;
			}

			const connection = yield* pasaport.listContributions({
				authorId: row.userId,
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
};
