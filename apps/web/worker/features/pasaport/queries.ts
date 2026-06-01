/**
 * Pasaport root query resolvers — `me`, `profile(username)`.
 *
 * Thin orchestration over `Pasaport`, wrapped by `fateQuery` so it runs through
 * the request runtime (see `.patterns/fate-effect-bridge.md`). Query resolvers
 * return shaped output directly — they are **not** masked through a source, so
 * the resolver builds the exact wire shape the client selected (including
 * nested connections).
 *
 * Roots:
 *   - `me` — the "current user" root (fate's documented `viewer` pattern); reads
 *     the canonical Pasaport row so a fresh `username` round-trips right after
 *     `setUsername` (better-auth's session inference lags), falls back to the
 *     session user when the row isn't found. Anonymous → `UNAUTHORIZED`.
 *   - `profile(username)` — the public profile page. Returns `null` for an
 *     unknown username (the SPA renders its 404). Identity + live-aggregated
 *     counters come from `Pasaport.lookupProfile`; the `contributions` connection
 *     is delivered inline by the resolver (see `.patterns/fate-connections.md`).
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import {hasNestedSelection} from "@nkzw/fate/server";
import {fateQuery} from "../fate/effect.ts";
import {toConnection} from "../fate/shapers.ts";
import type {Contribution, Profile, User} from "../fate/views.ts";
import {Auth} from "./Auth.ts";
import {Pasaport} from "./Pasaport.ts";
import {toContributionRow, toUser} from "./shapers.ts";

/** Default page size for the nested `Profile.contributions` feed. */
const CONTRIBUTIONS_PAGE_SIZE = 20;

export const queries = {
	me: {
		type: "User",
		// Returns the full `User` row
		// (`id, email, name, image, username`). Reads the canonical row through
		// `Pasaport.getUserById` so a fresh `username` round-trips right after
		// `setUsername` (better-auth's session inference lags); falls back to the
		// session user when the row isn't found. Anonymous → `UNAUTHORIZED`.
		resolve: fateQuery<undefined, User>(function* () {
			const {user} = yield* Auth.required; // Unauthorized → UNAUTHORIZED
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
	},
	/**
	 * Public profile by username. Returns `null` for an unknown username (the SPA
	 * renders its 404). Identity + live-aggregated counters come from
	 * `Pasaport.lookupProfile`; identity fields are flat scalars on the profile.
	 *
	 * `contributions` resolves to a `ConnectionResult` only when selected, paged
	 * by the DB keyset (`Pasaport.listContributions`, `(createdAt desc, id desc)`)
	 * — the same discriminant feed the source `connection` executor delegates to,
	 * delivered inline here because the native path doesn't auto-invoke a
	 * hand-built source's nested `connection` (see fate-connections.md). The
	 * discriminant `kind` is preserved on every node.
	 */
	profile: {
		type: "Profile",
		resolve: fateQuery<
			{username: string; contributions?: {first?: number; after?: string}},
			Profile | null
		>(function* ({args, select}) {
			const username = args?.username ?? "";
			const pasaport = yield* Pasaport;
			const row = yield* pasaport.lookupProfile(username);
			if (!row) return null;

			const base: Profile = {
				__typename: "Profile",
				// `id` === `userId`: the client normalizes by `record.id` (a `Profile`
				// is one-to-one with its user).
				id: row.userId,
				userId: row.userId,
				username: row.username,
				displayName: row.displayName,
				image: row.image,
				totalKarma: row.totalKarma,
				definitionCount: row.definitionCount,
				postCount: row.postCount,
				commentCount: row.commentCount,
			};

			if (!hasNestedSelection(select, "contributions")) {
				return base;
			}

			// Nested connection args are scoped under the field path
			// (`args.contributions.{first,after}`), matching fate's `getScopedArgs`.
			const cArgs = args?.contributions;
			const connection = yield* pasaport.listContributions({
				authorId: row.userId,
				first: typeof cArgs?.first === "number" ? cArgs.first : CONTRIBUTIONS_PAGE_SIZE,
				after: typeof cArgs?.after === "string" ? cArgs.after : null,
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

			return {...base, contributions} as Profile & {
				contributions: ConnectionResult<Contribution>;
			};
		}),
	},
};
