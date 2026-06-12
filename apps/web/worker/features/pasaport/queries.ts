/**
 * Pasaport root query resolvers — `me`, `profile(username)`.
 *
 * `Fate.query` def + `Effect.fn("<wire name>")` pairs
 * (`.patterns/fate-effect-operations.md`). Query resolvers return shaped
 * output directly — they are **not** masked through a source, so the resolver
 * builds the exact wire shape the client selected (including nested
 * connections).
 *
 * Roots:
 *   - `me` — the "current user" root (fate's documented `viewer` pattern); reads
 *     the canonical Pasaport row so a fresh `username` round-trips right after
 *     `setUsername` (better-auth's session inference lags), falls back to the
 *     session user when the row isn't found. Anonymous → `UNAUTHORIZED` via
 *     `CurrentUser.required` (the package's `Unauthorized`, declared on the
 *     definition).
 *   - `profile(username)` — the public profile page. Returns `null` for an
 *     unknown username (the SPA renders its 404). Identity + live-aggregated
 *     counters come from `Pasaport.lookupProfile`; the `contributions` connection
 *     is delivered inline by the resolver (see `.patterns/fate-connections.md`).
 */

import {hasNestedSelection} from "@nkzw/fate/server";
import {CurrentUser, Fate, Unauthorized} from "@phoenix/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {connectionArgs, keysetInput, toConnection} from "../fate/connection.ts";
import {Pasaport} from "./Pasaport.ts";
import {toContributionRow, toProfile, toUser} from "./shapers.ts";
import type {Contribution} from "./views.ts";
import {ProfileView, UserView} from "./views.ts";

/** Default page size for the nested `Profile.contributions` feed. */
const CONTRIBUTIONS_PAGE_SIZE = 20;

/**
 * `profile(username)` args. Nested connection args are scoped under the field
 * path (`args.contributions.{first,after}`), matching fate's `getScopedArgs`.
 */
const ProfileArgs = Schema.Struct({
	username: Schema.String,
	contributions: connectionArgs(),
});

export const queries = {
	me: Fate.query(
		{type: UserView, error: Unauthorized},
		// Returns the full `User` row (`id, email, name, image, username`). Reads
		// the canonical row through `Pasaport.getUserById` so a fresh `username`
		// round-trips right after `setUsername` (better-auth's session inference
		// lags); falls back to the session user when the row isn't found.
		// Anonymous → `UNAUTHORIZED`.
		Effect.fn("me")(function* () {
			const user = yield* CurrentUser.required; // Unauthorized → UNAUTHORIZED
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
	/**
	 * Public profile by username. Returns `null` for an unknown username (the SPA
	 * renders its 404). Identity + live-aggregated counters come from
	 * `Pasaport.lookupProfile`; identity fields are flat scalars on the profile.
	 *
	 * `contributions` resolves to a `ConnectionResult` only when selected, paged
	 * by the DB keyset (`Pasaport.listContributions`, `(createdAt desc, id desc)`)
	 * — the same discriminant feed a source `connection` capability would
	 * delegate to, delivered inline here because the native path doesn't
	 * auto-invoke a hand-built source's nested `connection` (see
	 * fate-connections.md). The discriminant `kind` is preserved on every node.
	 */
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

			// `listContributions` takes a required `after: string | null`, so the
			// keyset input's present-only `after` lands as an explicit `null`.
			const input = keysetInput(args.contributions, CONTRIBUTIONS_PAGE_SIZE);
			const connection = yield* pasaport.listContributions({
				authorId: row.userId,
				first: input.first,
				after: input.after ?? null,
			});
			const contributions = toConnection<(typeof connection.edges)[number], Contribution>(
				{
					rows: connection.edges,
					hasNextPage: connection.hasNextPage,
					endCursor: connection.endCursor,
				},
				(edge) => edge.cursor,
				(edge) => ({__typename: "Contribution", ...toContributionRow(edge.node)}),
			);

			return {...base, contributions};
		}),
	),
};
