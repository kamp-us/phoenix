/**
 * Root query resolvers.
 *
 * Each is a thin orchestration over a service, wrapped by `fateQuery` so it
 * runs through the request runtime (see `.patterns/fate-effect-bridge.md`).
 * Query resolvers return shaped output directly — they are **not** masked
 * through a source, so the resolver builds the exact wire shape the client
 * selected (including nested connections).
 *
 * Roots:
 *   - `health` / `me` — the trivial roots (seam proof + auth path).
 *   - `term(slug)` — the sozluk detail page. Returns the `Term` entity; when the
 *     selection includes `definitions`, it carries a pre-built `ConnectionResult`
 *     paged by the DB keyset (`Sozluk.listDefinitionsKeyset`) in the canonical
 *     term-page order. See the connection note in `.patterns/fate-connections.md`.
 *
 * The terms *list* is a `lists` resolver (`lists.ts`); definition mutations are
 * in `mutations.ts`.
 */

import type {ConnectionResult} from "@nkzw/fate/server";
import {hasNestedSelection} from "@nkzw/fate/server";
import {Pano} from "../features/pano/Pano";
import {Pasaport, toContributionRow} from "../features/pasaport/Pasaport";
import {Sozluk} from "../features/sozluk/Sozluk";
import {Stats} from "../features/stats/Stats";
import {Auth} from "../services";
import {fateQuery} from "./effect";
import type {
	Comment,
	Contribution,
	Definition,
	LandingStats,
	Post,
	Profile,
	Term,
	User,
} from "./views";

export interface Health {
	readonly status: "ok";
	readonly definitions: number;
}

/** Build tag the landing card renders. */
const PHOENIX_BUILD_VERSION = "v0.3";

/**
 * Constant id for the singleton `LandingStats` entity. There is only ever one
 * landing-stats row; the client normalizes by `record.id`, so a stable id keeps
 * it a single cache record.
 */
const LANDING_STATS_ID = "landing";

/** Default page size for the nested `Term.definitions` connection. */
const DEFINITIONS_PAGE_SIZE = 50;

/** Default page size for the nested `Post.comments` connection. */
const COMMENTS_PAGE_SIZE = 50;

/** Default page size for the nested `Profile.contributions` feed. */
const CONTRIBUTIONS_PAGE_SIZE = 20;

export const queries = {
	health: {
		type: "Health",
		resolve: fateQuery<undefined, Health>(function* () {
			const stats = yield* Stats;
			const {totalDefinitions} = yield* stats.getLandingStats();
			return {status: "ok", definitions: totalDefinitions} satisfies Health;
		}),
	},
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
				return {
					__typename: "User",
					id: user.id,
					email: user.email,
					name: user.name ?? null,
					image: user.image ?? null,
					username: null,
				};
			}
			return {__typename: "User", ...fresh};
		}),
	},
	term: {
		type: "Term",
		resolve: fateQuery<{slug: string; definitions?: {first?: number; after?: string}}, Term | null>(
			function* ({args, select}) {
				const slug = args?.slug ?? "";
				const sozluk = yield* Sozluk;
				const page = yield* sozluk.getTerm(slug);
				if (!page) return null;

				const auth = yield* Auth;
				const viewerId = auth.user?.id ?? null;

				// Build the `Term` row to the view's scalar shape: the detail `TermPage`
				// maps onto the `TermSummaryRow`-shaped view here.
				const base: Term = {
					__typename: "Term",
					id: page.slug,
					slug: page.slug,
					title: page.title,
					count: page.totalDefinitions,
					totalScore: page.totalScore,
					excerpt: null,
					firstAt: page.firstAt,
					lastEdit: page.lastEdit,
					firstLetter: (page.title?.[0] ?? page.slug.charAt(0) ?? "").toLowerCase(),
					definitionCount: page.totalDefinitions,
					lastActivityAt: page.lastEdit,
				};

				// `definitions` resolves to a `ConnectionResult` only when selected,
				// paged by the DB keyset. The native path doesn't auto-invoke a
				// nested relation's `connection` executor for a hand-built source, so
				// the resolver delivers the connection inline (see
				// fate-connections.md); the keyset, cursor, and node shape match the
				// source `connection` executor exactly.
				if (!hasNestedSelection(select, "definitions")) {
					return base;
				}

				// Nested connection args are scoped under the field path
				// (`args.definitions.{first,after}`), matching fate's `getScopedArgs`.
				const defArgs = args?.definitions;
				const connection = yield* sozluk.listDefinitionsKeyset(slug, {
					first: typeof defArgs?.first === "number" ? defArgs.first : DEFINITIONS_PAGE_SIZE,
					...(typeof defArgs?.after === "string" ? {after: defArgs.after} : {}),
					viewerId,
				});
				const definitions: ConnectionResult<Definition> = {
					items: connection.rows.map((row) => ({
						cursor: row.id,
						node: {
							__typename: "Definition",
							id: row.id,
							body: row.body,
							score: row.score,
							author: row.author,
							authorId: row.authorId,
							createdAt: row.createdAt,
							updatedAt: row.updatedAt,
							myVote: row.myVote ?? null,
						} satisfies Definition,
					})),
					pagination: {
						hasNext: connection.hasNextPage,
						hasPrevious: false,
						...(connection.endCursor ? {nextCursor: connection.endCursor} : {}),
					},
				};

				return {...base, definitions} as Term & {definitions: ConnectionResult<Definition>};
			},
		),
	},
	post: {
		type: "Post",
		resolve: fateQuery<
			{idOrSlug: string; comments?: {first?: number; after?: string}},
			Post | null
		>(function* ({args, select}) {
			// Raw per-type id (no global-id encoding — fate carries the type on the
			// operation). `Post.id` is the raw post id.
			const key = args?.idOrSlug ?? "";
			const pano = yield* Pano;
			const page = yield* pano.getPost(key);
			if (!page) return null;

			const auth = yield* Auth;
			const viewerId = auth.user?.id ?? null;

			// Stamp the viewer's vote so `Post.myVote` is authoritative without a
			// per-row resolver: batch the single post through the same `user_vote`
			// read.
			const [stamped] = yield* pano.getPostsByIds([page.id], {viewerId});

			const base: Post = {
				__typename: "Post",
				id: page.id,
				slug: page.slug,
				title: page.title,
				url: page.url,
				host: page.host,
				body: page.body,
				author: page.author,
				authorId: page.authorId,
				score: page.score,
				commentCount: page.commentCount,
				createdAt: page.createdAt,
				updatedAt: page.updatedAt,
				myVote: stamped?.myVote ?? null,
				tags: page.tags,
			};

			// `comments` resolves to a `ConnectionResult` only when selected, paged
			// by the DB keyset (`Pano.listCommentsKeyset`). The native path
			// doesn't auto-invoke a nested relation's `connection` executor for a
			// hand-built source, so the resolver delivers it inline (see
			// fate-connections.md); the keyset, cursor, and node shape match the
			// source `connection` executor exactly.
			if (!hasNestedSelection(select, "comments")) {
				return base;
			}

			const cArgs = args?.comments;
			const connection = yield* pano.listCommentsKeyset(page.id, {
				first: typeof cArgs?.first === "number" ? cArgs.first : COMMENTS_PAGE_SIZE,
				...(typeof cArgs?.after === "string" ? {after: cArgs.after} : {}),
				viewerId,
			});
			const comments: ConnectionResult<Comment> = {
				items: connection.rows.map((row) => ({
					cursor: row.id,
					node: {
						__typename: "Comment",
						id: row.id,
						parentId: row.parentId,
						author: row.author,
						authorId: row.authorId,
						body: row.body,
						score: row.score,
						createdAt: row.createdAt,
						updatedAt: row.updatedAt,
						deletedAt: row.deletedAt ?? null,
						myVote: row.myVote ?? null,
					} satisfies Comment,
				})),
				pagination: {
					hasNext: connection.hasNextPage,
					hasPrevious: false,
					...(connection.endCursor ? {nextCursor: connection.endCursor} : {}),
				},
			};

			return {...base, comments} as Post & {comments: ConnectionResult<Comment>};
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
			const contributions: ConnectionResult<Contribution> = {
				items: connection.edges.map((edge) => ({
					cursor: edge.cursor,
					node: {
						__typename: "Contribution",
						...toContributionRow(edge.node),
					} satisfies Contribution,
				})),
				pagination: {
					hasNext: connection.hasNextPage,
					hasPrevious: false,
					...(connection.endCursor ? {nextCursor: connection.endCursor} : {}),
				},
			};

			return {...base, contributions} as Profile & {
				contributions: ConnectionResult<Contribution>;
			};
		}),
	},
	/**
	 * Landing-page stats card. Reads the
	 * single-row aggregates + cross-product distinct-author union via
	 * `Stats.getLandingStats`, plus the build `version` the SPA renders.
	 *
	 * Returns the `LandingStats` entity stamped with a constant `id`
	 * (`LANDING_STATS_ID`) so the client normalizes it to a single cache record
	 * (the codegen hardcodes `getId` to `record.id`). There is only ever one
	 * landing-stats row, so the constant id is stable.
	 */
	landingStats: {
		type: "LandingStats",
		resolve: fateQuery<undefined, LandingStats>(function* () {
			const stats = yield* Stats;
			const result = yield* stats.getLandingStats();
			return {
				__typename: "LandingStats",
				id: LANDING_STATS_ID,
				...result,
				version: PHOENIX_BUILD_VERSION,
			};
		}),
	},
};
