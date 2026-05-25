/**
 * Pasaport — the user identity + profile service.
 *
 * Surface (resolver-facing):
 *   - `validateSession(headers)` — per-request session lookup via better-auth.
 *   - `handleAuth(request)`       — better-auth handler for `/api/auth/*`.
 *   - `getUserById(userId)`       — canonical user row by id.
 *   - `findUsername(username)`    — reverse lookup, used by tests + admin tools.
 *   - `countUsersWithoutUsername` — admin/backfill helper.
 *   - `setUsername({userId, value})` — bootstrap-step username write +
 *     `user_profile` upsert in one D1 batch.
 *   - `lookupProfile(username)` / `lookupProfileById(userId)` — profile-page
 *     identity + live-aggregated counts.
 *   - `listContributions({authorId, after, first})` — interleaved feed across
 *     `definition_view` + `post_summary` + `comment_view`, paginated by
 *     `(created_at DESC, id DESC)` keyset cursor.
 *
 * Validation lives inside the service methods as closure helpers (ADR 0013).
 * Per-username constraints live in `assertUsername` — see
 * {@link UsernameInvalid} for the wire-code mapping.
 *
 * Errors raised:
 *   - `UsernameInvalid` (with `code: invalid_format | too_short | too_long`)
 *   - `UsernameTaken`
 *   - `UsernameAlreadySet`
 *   - `UserNotFound`
 *   - `DrizzleError` (any infrastructure failure)
 */
import {and, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import * as schema from "../../db/drizzle/schema";
import {forwardPage, keysetAfter} from "../../db/keyset";
import {CloudflareEnv} from "../../services/CloudflareEnv";
import {Drizzle, type DrizzleError} from "../../services/Drizzle";
import {createAuth, type Session} from "./auth";
import {UserNotFound, UsernameAlreadySet, UsernameInvalid, UsernameTaken} from "./errors";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface UserRow {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

export interface SetUsernameResult {
	userId: string;
	username: string;
	displayName: string | null;
	image: string | null;
}

export interface BackfillProfilesResult {
	emitted: number;
}

export interface ProfileRow {
	userId: string;
	username: string;
	displayName: string | null;
	image: string | null;
	totalKarma: number;
	definitionCount: number;
	postCount: number;
	commentCount: number;
}

export type ContributionKind = "definition" | "post" | "comment";

interface DefinitionContributionNode {
	kind: "definition";
	id: string;
	createdAt: Date;
	score: number;
	bodyExcerpt: string;
	termSlug: string;
	termTitle: string;
}

interface PostContributionNode {
	kind: "post";
	id: string;
	createdAt: Date;
	score: number;
	title: string;
	slug: string | null;
	bodyExcerpt: string | null;
}

interface CommentContributionNode {
	kind: "comment";
	id: string;
	createdAt: Date;
	score: number;
	bodyExcerpt: string;
	postId: string;
	postTitle: string;
}

export type ContributionNode =
	| DefinitionContributionNode
	| PostContributionNode
	| CommentContributionNode;

export interface ContributionEdge {
	cursor: string;
	node: ContributionNode;
}

export interface ContributionConnection {
	edges: ContributionEdge[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

/**
 * Flat **discriminant** row for the fate `Profile.contributions` view (ADR
 * 0018 — fate has no union type, so heterogeneous contributions are modeled as
 * one view with a `kind` discriminant the profile page switches on).
 * The common fields (`kind`, `id`, `score`, `createdAt`) are always present;
 * the variant fields are nullable and populated per `kind`. This is purely a
 * reshape of {@link ContributionNode} — the same rows, the same keyset, the
 * same cursor — flattened so a single data view can mask them.
 */
export interface ContributionRow {
	kind: ContributionKind;
	id: string;
	score: number;
	createdAt: Date;
	// definition + comment carry a non-null excerpt; post's is nullable.
	bodyExcerpt: string | null;
	// definition only
	termSlug: string | null;
	termTitle: string | null;
	// post only
	title: string | null;
	slug: string | null;
	// comment only
	postId: string | null;
	postTitle: string | null;
}

/**
 * Flatten a discriminated {@link ContributionNode} into the flat
 * {@link ContributionRow} the fate view masks. The discriminant `kind` is
 * carried straight through; non-applicable variant fields are `null`.
 */
export function toContributionRow(node: ContributionNode): ContributionRow {
	const base = {kind: node.kind, id: node.id, score: node.score, createdAt: node.createdAt};
	switch (node.kind) {
		case "definition":
			return {
				...base,
				bodyExcerpt: node.bodyExcerpt,
				termSlug: node.termSlug,
				termTitle: node.termTitle,
				title: null,
				slug: null,
				postId: null,
				postTitle: null,
			};
		case "post":
			return {
				...base,
				bodyExcerpt: node.bodyExcerpt,
				termSlug: null,
				termTitle: null,
				title: node.title,
				slug: node.slug,
				postId: null,
				postTitle: null,
			};
		case "comment":
			return {
				...base,
				bodyExcerpt: node.bodyExcerpt,
				termSlug: null,
				termTitle: null,
				title: null,
				slug: null,
				postId: node.postId,
				postTitle: node.postTitle,
			};
	}
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class Pasaport extends Context.Service<
	Pasaport,
	{
		readonly handleAuth: (request: Request) => Effect.Effect<Response, never>;

		readonly validateSession: (headers: Headers) => Effect.Effect<Session | null, never>;

		readonly getUserById: (userId: string) => Effect.Effect<UserRow | null, DrizzleError>;

		/**
		 * Batched read of user rows by id — the fate `User` source's `byIds`
		 * workhorse. `User` is the hottest relation (authors appear across every
		 * feed), so this is a single `WHERE id IN (...)` over the user table.
		 * Order is not guaranteed; fate re-associates rows by id.
		 */
		readonly getUsersByIds: (
			userIds: ReadonlyArray<string>,
		) => Effect.Effect<UserRow[], DrizzleError>;

		readonly findUsername: (
			username: string,
		) => Effect.Effect<{userId: string; username: string} | null, DrizzleError>;

		readonly countUsersWithoutUsername: Effect.Effect<number, DrizzleError>;

		readonly setUsername: (input: {
			userId: string;
			value: string;
		}) => Effect.Effect<
			SetUsernameResult,
			UsernameInvalid | UsernameTaken | UsernameAlreadySet | UserNotFound | DrizzleError
		>;

		readonly lookupProfile: (username: string) => Effect.Effect<ProfileRow | null, DrizzleError>;

		readonly lookupProfileById: (userId: string) => Effect.Effect<ProfileRow | null, DrizzleError>;

		readonly listContributions: (input: {
			authorId: string;
			after: string | null;
			first: number;
		}) => Effect.Effect<ContributionConnection, DrizzleError>;
	}
>()("@phoenix/pasaport/Pasaport") {}

/* -------------------------------------------------------------------------- */
/* Username validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Username constraints (mirrored on the SPA bootstrap form):
 * - 3 to 30 chars
 * - lowercase ASCII letters, digits, and `-` only
 * - must start with a letter or digit (no leading/trailing `-`, no `--`)
 */
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;

function assertUsername(normalized: string): Effect.Effect<void, UsernameInvalid> {
	if (normalized.length < 3) {
		return Effect.fail(
			new UsernameInvalid({
				code: "too_short",
				message: "kullanıcı adı en az 3 karakter olmalı",
			}),
		);
	}
	if (normalized.length > 30) {
		return Effect.fail(
			new UsernameInvalid({
				code: "too_long",
				message: "kullanıcı adı en fazla 30 karakter olabilir",
			}),
		);
	}
	if (!USERNAME_REGEX.test(normalized)) {
		return Effect.fail(
			new UsernameInvalid({
				code: "invalid_format",
				message: "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
			}),
		);
	}
	return Effect.void;
}

/* -------------------------------------------------------------------------- */
/* Contributions cursor codec — the (created_at DESC, id DESC) keyset           */
/* -------------------------------------------------------------------------- */

/**
 * The contributions feed is paginated by a DB keyset matching the fate
 * `Profile.contributions` view `orderBy` — `(createdAt desc, id desc)` — with
 * `id` (a globally-unique ULID across all three contribution tables) as the
 * final tiebreaker. The cursor is the `(createdAt, id)` tuple of the last node
 * on a page; `decodeCursor` resolves it back so the per-table keyset predicate
 * `createdAt < c.createdAt OR (createdAt = c.createdAt AND id < c.id)` selects
 * the rows that follow it. No skips or duplicates, and the discriminant `kind`
 * is preserved across pages because the keyset key is the same global
 * `(createdAt, id)` order every kind is merged on.
 *
 * D1 stores `created_at` as epoch **seconds** (the `timestamp` column is
 * `integer({mode:"timestamp"})`), so encoding seconds is exact at the DB's own
 * granularity — the keyset round-trips without precision loss. The wire cursor
 * format is `<epochSeconds>:<id>`, so cursors stay stable across deploys.
 */
function encodeCursor(node: {createdAt: Date; id: string}): string {
	return `${Math.floor(node.createdAt.getTime() / 1000)}:${node.id}`;
}

function decodeCursor(cursor: string): {createdAt: Date; id: string} | null {
	const idx = cursor.indexOf(":");
	if (idx < 0) return null;
	const tsRaw = cursor.slice(0, idx);
	const id = cursor.slice(idx + 1);
	const ts = Number(tsRaw);
	if (!Number.isFinite(ts) || !id) return null;
	return {createdAt: new Date(ts * 1000), id};
}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

export const PasaportLive = Layer.effect(Pasaport)(
	Effect.gen(function* () {
		const env = yield* CloudflareEnv;
		// Per the post-fbb57d8 reshape: yield Drizzle once at layer build and
		// destructure its bound methods. Method bodies call `run` / `batch`
		// directly so every method's `R` stays `never`.
		const {run} = yield* Drizzle;

		const upsertProfileIdentity = Effect.fn("Pasaport.upsertProfileIdentity")(function* (args: {
			userId: string;
			username: string | null;
			displayName: string | null;
			image: string | null;
			updatedAtSec: number;
		}) {
			yield* run((db) =>
				db.run(sql`
					INSERT INTO user_profile (
						user_id, username, display_name, image,
						total_karma, definition_count, post_count, comment_count,
						updated_at
					) VALUES (
						${args.userId}, ${args.username}, ${args.displayName}, ${args.image},
						0, 0, 0, 0, ${args.updatedAtSec}
					)
					ON CONFLICT(user_id) DO UPDATE SET
						username      = COALESCE(excluded.username, user_profile.username),
						display_name  = excluded.display_name,
						image         = excluded.image,
						updated_at    = excluded.updated_at
				`),
			);
		});

		const hydrateProfile = Effect.fn("Pasaport.hydrateProfile")(function* (row: {
			userId: string;
			username: string;
			displayName: string | null;
			image: string | null;
			totalKarma: number;
		}) {
			const authorId = row.userId;
			const defCount = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.definitionView)
					.where(
						and(
							eq(schema.definitionView.authorId, authorId),
							isNull(schema.definitionView.deletedAt),
						),
					)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const postCount = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.postSummary)
					.where(
						and(eq(schema.postSummary.authorId, authorId), isNull(schema.postSummary.deletedAt)),
					)
					.then((r) => Number(r[0]?.n ?? 0)),
			);
			const commentCount = yield* run((db) =>
				db
					.select({n: sql<number>`COUNT(*)`})
					.from(schema.commentView)
					.where(
						and(eq(schema.commentView.authorId, authorId), isNull(schema.commentView.deletedAt)),
					)
					.then((r) => Number(r[0]?.n ?? 0)),
			);

			return {
				userId: row.userId,
				username: row.username,
				displayName: row.displayName,
				image: row.image,
				totalKarma: row.totalKarma,
				definitionCount: defCount,
				postCount,
				commentCount,
			} satisfies ProfileRow;
		});

		return {
			handleAuth: Effect.fn("Pasaport.handleAuth")(function* (request: Request) {
				const auth = createAuth(env.PHOENIX_DB, env.BETTER_AUTH_SECRET);
				return yield* Effect.promise(() => auth.handler(request));
			}),

			validateSession: Effect.fn("Pasaport.validateSession")(function* (headers: Headers) {
				// better-auth's `getSession` can throw on a flaky JWT, missing
				// cookie, etc. Treat any failure as "no session" — same
				// behavior as the legacy module function, which logged +
				// swallowed.
				return yield* Effect.tryPromise({
					try: async () => {
						const auth = createAuth(env.PHOENIX_DB, env.BETTER_AUTH_SECRET);
						const session = await auth.api.getSession({headers});
						if (!session?.user) return null;
						return session;
					},
					catch: (cause): {readonly _tag: "ValidateSessionError"; readonly cause: unknown} => ({
						_tag: "ValidateSessionError",
						cause,
					}),
				}).pipe(
					Effect.catch((error) =>
						Effect.sync(() => {
							console.error("[pasaport.validateSession]", error.cause);
							return null as Session | null;
						}),
					),
				);
			}),

			getUserById: Effect.fn("Pasaport.getUserById")(function* (userId: string) {
				const row = yield* run((db) =>
					db.query.user.findFirst({where: eq(schema.user.id, userId)}),
				);
				if (!row) return null;
				return {
					id: row.id,
					email: row.email,
					name: row.name ?? null,
					image: row.image ?? null,
					username: row.username ?? null,
				} satisfies UserRow;
			}),

			getUsersByIds: Effect.fn("Pasaport.getUsersByIds")(function* (
				userIds: ReadonlyArray<string>,
			) {
				if (userIds.length === 0) return [];
				const rows = yield* run((db) =>
					db.query.user.findMany({where: inArray(schema.user.id, [...userIds])}),
				);
				return rows.map(
					(row) =>
						({
							id: row.id,
							email: row.email,
							name: row.name ?? null,
							image: row.image ?? null,
							username: row.username ?? null,
						}) satisfies UserRow,
				);
			}),

			findUsername: Effect.fn("Pasaport.findUsername")(function* (username: string) {
				const row = yield* run((db) =>
					db.query.user.findFirst({where: eq(schema.user.username, username)}),
				);
				if (!row?.username) return null;
				return {userId: row.id, username: row.username};
			}),

			countUsersWithoutUsername: Effect.gen(function* () {
				const rows = yield* run((db) =>
					db.select({id: schema.user.id}).from(schema.user).where(isNull(schema.user.username)),
				);
				return rows.length;
			}),

			setUsername: Effect.fn("Pasaport.setUsername")(function* (input: {
				userId: string;
				value: string;
			}) {
				const {userId} = input;
				const normalized = input.value.trim().toLowerCase();
				yield* assertUsername(normalized);

				const existingUser = yield* run((db) =>
					db.query.user.findFirst({where: eq(schema.user.id, userId)}),
				);
				if (!existingUser) {
					return yield* new UserNotFound({message: "kullanıcı bulunamadı"});
				}
				if (existingUser.username) {
					return yield* new UsernameAlreadySet({
						message: "kullanıcı adı zaten ayarlandı; değiştirilemez",
					});
				}

				const conflict = yield* run((db) =>
					db.query.user.findFirst({where: eq(schema.user.username, normalized)}),
				);
				if (conflict) {
					return yield* new UsernameTaken({message: "bu kullanıcı adı kullanımda"});
				}

				const now = new Date();

				yield* run((db) =>
					db
						.update(schema.user)
						.set({username: normalized, updatedAt: now})
						.where(eq(schema.user.id, userId)),
				);

				yield* upsertProfileIdentity({
					userId,
					username: normalized,
					displayName: existingUser.name ?? null,
					image: existingUser.image ?? null,
					updatedAtSec: Math.floor(now.getTime() / 1000),
				});

				return {
					userId,
					username: normalized,
					displayName: existingUser.name ?? null,
					image: existingUser.image ?? null,
				} satisfies SetUsernameResult;
			}),

			lookupProfile: Effect.fn("Pasaport.lookupProfile")(function* (username: string) {
				const rows = yield* run((db) =>
					db
						.select({
							userId: schema.userProfile.userId,
							username: schema.userProfile.username,
							displayName: schema.userProfile.displayName,
							image: schema.userProfile.image,
							totalKarma: schema.userProfile.totalKarma,
						})
						.from(schema.userProfile)
						.where(eq(schema.userProfile.username, username))
						.limit(1),
				);
				const row = rows[0];
				if (!row || row.username == null) return null;
				return yield* hydrateProfile({...row, username: row.username});
			}),

			lookupProfileById: Effect.fn("Pasaport.lookupProfileById")(function* (userId: string) {
				const rows = yield* run((db) =>
					db
						.select({
							userId: schema.userProfile.userId,
							username: schema.userProfile.username,
							displayName: schema.userProfile.displayName,
							image: schema.userProfile.image,
							totalKarma: schema.userProfile.totalKarma,
						})
						.from(schema.userProfile)
						.where(eq(schema.userProfile.userId, userId))
						.limit(1),
				);
				const row = rows[0];
				if (!row || row.username == null) return null;
				return yield* hydrateProfile({...row, username: row.username});
			}),

			listContributions: Effect.fn("Pasaport.listContributions")(function* (input: {
				authorId: string;
				after: string | null;
				first: number;
			}) {
				const first = Math.max(1, Math.min(input.first, 50));
				const cursor = input.after ? decodeCursor(input.after) : null;
				const fetchSize = first + 1;

				// `after` present but undecodable is a cursor miss → empty page (the
				// one cursor-miss semantic shared by all five keyset methods).
				const cursorMissed = input.after !== null && cursor === null;

				// Per-table keyset for the global `(created_at desc, id desc)` merge
				// order. `keysetAfter` builds the lexicographic predicate; null
				// cursor values (no `after`) collapse it to undefined so only the
				// base author/deleted filter applies.
				function keysetWhere<
					TTable extends {createdAt: any; id: any; authorId: any; deletedAt: any},
				>(table: TTable) {
					const base = and(eq(table.authorId, input.authorId), isNull(table.deletedAt));
					const predicate = keysetAfter([
						{column: table.createdAt, dir: "desc", value: cursor?.createdAt ?? null},
						{column: table.id, dir: "desc", value: cursor?.id ?? null},
					]);
					return predicate ? and(base, predicate) : base;
				}

				const defs = yield* run((db) =>
					db
						.select({
							id: schema.definitionView.id,
							createdAt: schema.definitionView.createdAt,
							score: schema.definitionView.score,
							bodyExcerpt: schema.definitionView.bodyExcerpt,
							termSlug: schema.definitionView.termSlug,
							termTitle: schema.definitionView.termTitle,
						})
						.from(schema.definitionView)
						.where(keysetWhere(schema.definitionView))
						.orderBy(desc(schema.definitionView.createdAt), desc(schema.definitionView.id))
						.limit(fetchSize),
				);

				const posts = yield* run((db) =>
					db
						.select({
							id: schema.postSummary.id,
							slug: schema.postSummary.slug,
							createdAt: schema.postSummary.createdAt,
							score: schema.postSummary.score,
							title: schema.postSummary.title,
							bodyExcerpt: schema.postSummary.bodyExcerpt,
						})
						.from(schema.postSummary)
						.where(keysetWhere(schema.postSummary))
						.orderBy(desc(schema.postSummary.createdAt), desc(schema.postSummary.id))
						.limit(fetchSize),
				);

				const comments = yield* run((db) =>
					db
						.select({
							id: schema.commentView.id,
							createdAt: schema.commentView.createdAt,
							score: schema.commentView.score,
							bodyExcerpt: schema.commentView.bodyExcerpt,
							postId: schema.commentView.postId,
							postTitle: schema.commentView.postTitle,
						})
						.from(schema.commentView)
						.where(keysetWhere(schema.commentView))
						.orderBy(desc(schema.commentView.createdAt), desc(schema.commentView.id))
						.limit(fetchSize),
				);

				const defTotal = yield* run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(schema.definitionView)
						.where(
							and(
								eq(schema.definitionView.authorId, input.authorId),
								isNull(schema.definitionView.deletedAt),
							),
						)
						.then((r) => Number(r[0]?.n ?? 0)),
				);
				const postTotal = yield* run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(schema.postSummary)
						.where(
							and(
								eq(schema.postSummary.authorId, input.authorId),
								isNull(schema.postSummary.deletedAt),
							),
						)
						.then((r) => Number(r[0]?.n ?? 0)),
				);
				const commentTotal = yield* run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(schema.commentView)
						.where(
							and(
								eq(schema.commentView.authorId, input.authorId),
								isNull(schema.commentView.deletedAt),
							),
						)
						.then((r) => Number(r[0]?.n ?? 0)),
				);
				const totalCount = defTotal + postTotal + commentTotal;

				if (cursorMissed) {
					return {
						edges: [],
						hasNextPage: false,
						endCursor: null,
						totalCount,
					} satisfies ContributionConnection;
				}

				const merged: ContributionNode[] = [
					...defs.map<ContributionNode>((d) => ({
						kind: "definition",
						id: d.id,
						createdAt: d.createdAt ?? new Date(0),
						score: d.score,
						bodyExcerpt: d.bodyExcerpt,
						termSlug: d.termSlug,
						termTitle: d.termTitle,
					})),
					...posts.map<ContributionNode>((p) => ({
						kind: "post",
						id: p.id,
						createdAt: p.createdAt ?? new Date(0),
						score: p.score,
						title: p.title,
						slug: p.slug,
						bodyExcerpt: p.bodyExcerpt,
					})),
					...comments.map<ContributionNode>((c) => ({
						kind: "comment",
						id: c.id,
						createdAt: c.createdAt ?? new Date(0),
						score: c.score,
						bodyExcerpt: c.bodyExcerpt,
						postId: c.postId,
						postTitle: c.postTitle,
					})),
				];

				merged.sort((a, b) => {
					const aTs = a.createdAt.getTime();
					const bTs = b.createdAt.getTime();
					if (aTs !== bTs) return bTs - aTs;
					return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
				});

				// Each of the three tables is read with the same keyset predicate and
				// `LIMIT first+1`, so the merged set holds every candidate that could
				// fall in the next `first` slots of the global `(createdAt desc, id
				// desc)` order — `forwardPage` slices the probe and assembles the
				// shared `{rows, hasNextPage, endCursor}` envelope.
				const page = forwardPage<ContributionNode>(merged, first, encodeCursor);

				return {
					edges: page.rows.map((node) => ({cursor: encodeCursor(node), node})),
					hasNextPage: page.hasNextPage,
					endCursor: page.endCursor,
					totalCount,
				} satisfies ContributionConnection;
			}),
		};
	}),
);
