/**
 * Pasaport — the user identity + profile service. Validation lives inside the
 * methods as closure helpers (ADR 0013). Infrastructure failures are NOT raised:
 * every internal DB call dies on `DrizzleError` (`orDieAccess` at layer build —
 * the domain-boundary rule), so the public signatures carry domain errors only.
 *
 * The auth instance is supplied by `BetterAuthLive` (`better-auth-live.ts`); the
 * `/api/auth/*` route reads `BetterAuth.fetch` from the same Context tag, so
 * `Pasaport` no longer mounts the handler itself.
 */
import type {Auth as BetterAuth} from "better-auth";
import {and, desc, eq, isNull, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {forwardPage, keysetAfter} from "../../db/keyset.ts";
import {
	UserNotFound,
	UsernameAlreadySet,
	type UsernameInvalid,
	UsernameInvalidFormat,
	UsernameTaken,
	UsernameTooLong,
	UsernameTooShort,
} from "./errors.ts";

// Phoenix never specializes the better-auth options at the type level, so this
// is the unparameterized `Auth` — matching the `BetterAuth` tag's `auth` field.
export type Auth = BetterAuth;
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

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
	rows: ContributionEdge[];
	hasNextPage: boolean;
	endCursor: string | null;
	totalCount: number;
}

// Flat **discriminant** reshape of {@link ContributionNode} (ADR 0018: fate has
// no union type). Variant fields are nullable, populated per `kind`.
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

export class Pasaport extends Context.Service<
	Pasaport,
	{
		readonly validateSession: (headers: Headers) => Effect.Effect<Session | null, never>;

		readonly getUserById: (userId: string) => Effect.Effect<UserRow | null>;

		// Single `WHERE id IN (...)`; order is not guaranteed (fate re-associates by id).
		readonly getUsersByIds: (userIds: ReadonlyArray<string>) => Effect.Effect<UserRow[]>;

		readonly setUsername: (input: {
			userId: string;
			value: string;
		}) => Effect.Effect<
			SetUsernameResult,
			UsernameInvalid | UsernameTaken | UsernameAlreadySet | UserNotFound
		>;

		readonly lookupProfile: (username: string) => Effect.Effect<ProfileRow | null>;

		readonly lookupProfileById: (userId: string) => Effect.Effect<ProfileRow | null>;

		readonly listContributions: (input: {
			authorId: string;
			after?: string | null | undefined;
			first: number;
		}) => Effect.Effect<ContributionConnection>;
	}
>()("@kampus/pasaport/Pasaport") {}

// Username constraints (mirrored on the SPA bootstrap form): 3-30 chars;
// lowercase ASCII letters, digits, and `-`; must start/end with a letter or
// digit (no leading/trailing `-`, no `--`).
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;

function assertUsername(normalized: string): Effect.Effect<void, UsernameInvalid> {
	if (normalized.length < 3) {
		return Effect.fail(
			new UsernameTooShort({
				message: "kullanıcı adı en az 3 karakter olmalı",
			}),
		);
	}
	if (normalized.length > 30) {
		return Effect.fail(
			new UsernameTooLong({
				message: "kullanıcı adı en fazla 30 karakter olabilir",
			}),
		);
	}
	if (!USERNAME_REGEX.test(normalized)) {
		return Effect.fail(
			new UsernameInvalidFormat({
				message: "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
			}),
		);
	}
	return Effect.void;
}

/**
 * Cursor codec for the `(createdAt desc, id desc)` keyset (matches the fate view
 * `orderBy`; `id` is a global ULID tiebreaker). Wire format `<epochSeconds>:<id>`.
 *
 * Encodes epoch **seconds** because D1 stores `created_at` as
 * `integer({mode:"timestamp"})` — seconds is the DB's own granularity, so the
 * keyset round-trips without precision loss and cursors stay stable across deploys.
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

/**
 * Build the `Pasaport` Layer over an already-resolved better-auth instance. The
 * worker resolves the `BetterAuth` tag once in init and hands the instance here;
 * sharing the single auth instance with the `/api/auth/*` route keeps session
 * cookies signed and validated by the same secret.
 */
export const makePasaportLive = (auth: Auth) =>
	Layer.effect(Pasaport)(
		Effect.gen(function* () {
			// `orDieAccess`: every DB call site dies on `DrizzleError` (infra
			// failures are defects — the domain-boundary rule), so public signatures
			// carry domain errors only and every method's `R` stays `never`.
			const {run} = orDieAccess(yield* Drizzle);

			// `COUNT(*)` of one author's live (non-removed) rows in a contribution
			// table. Calls `run` directly so callers keep `R = never`.
			const countByAuthor = (
				table: typeof schema.definitionView | typeof schema.postSummary | typeof schema.commentView,
				authorId: string,
			): Effect.Effect<number> =>
				run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(table)
						.where(and(eq(table.authorId, authorId), isNull(table.removedAt)))
						.then((r) => Number(r[0]?.n ?? 0)),
				);

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
				const defCount = yield* countByAuthor(schema.definitionView, authorId);
				const postCount = yield* countByAuthor(schema.postSummary, authorId);
				const commentCount = yield* countByAuthor(schema.commentView, authorId);

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
				validateSession: Effect.fn("Pasaport.validateSession")(function* (headers: Headers) {
					// better-auth's `getSession` can throw on a flaky JWT, missing
					// cookie, etc. Treat any failure as "no session" (log + swallow).
					return yield* Effect.tryPromise({
						try: async () => {
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
							Effect.gen(function* () {
								yield* Effect.logError("[pasaport.validateSession]", error.cause);
								return null as Session | null;
							}),
						),
					);
				}),

				getUserById: Effect.fn("Pasaport.getUserById")(function* (userId: string) {
					const row = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
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
						db.query.user.findMany({where: {id: {in: [...userIds]}}}),
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

				setUsername: Effect.fn("Pasaport.setUsername")(function* (input: {
					userId: string;
					value: string;
				}) {
					const {userId} = input;
					const normalized = input.value.trim().toLowerCase();
					yield* assertUsername(normalized);

					const existingUser = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					if (!existingUser) {
						return yield* new UserNotFound({message: "kullanıcı bulunamadı"});
					}
					if (existingUser.username) {
						return yield* new UsernameAlreadySet({
							message: "kullanıcı adı zaten ayarlandı; değiştirilemez",
						});
					}

					const conflict = yield* run((db) =>
						db.query.user.findFirst({where: {username: normalized}}),
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
					after?: string | null | undefined;
					first: number;
				}) {
					const first = Math.max(1, Math.min(input.first, 50));
					const cursor = input.after ? decodeCursor(input.after) : null;
					const fetchSize = first + 1;

					// `after` present but undecodable is a cursor miss → empty page.
					const cursorMissed = input.after != null && cursor === null;

					// Per-table keyset for the global `(created_at desc, id desc)` merge.
					// Null cursor values (no `after`) collapse the predicate to undefined
					// so only the base author/removed filter applies.
					function keysetWhere(
						table:
							| typeof schema.definitionView
							| typeof schema.postSummary
							| typeof schema.commentView,
					) {
						const base = and(eq(table.authorId, input.authorId), isNull(table.removedAt));
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

					const defTotal = yield* countByAuthor(schema.definitionView, input.authorId);
					const postTotal = yield* countByAuthor(schema.postSummary, input.authorId);
					const commentTotal = yield* countByAuthor(schema.commentView, input.authorId);
					const totalCount = defTotal + postTotal + commentTotal;

					if (cursorMissed) {
						return {
							rows: [],
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
						// (createdAt desc, id desc) — matches the per-table keyset order.
						if (aTs !== bTs) return bTs - aTs;
						if (a.id !== b.id) return a.id < b.id ? 1 : -1;
						return 0;
					});

					// Each table is read with `LIMIT first+1` under the same keyset, so
					// the merged set holds every candidate for the next `first` slots of
					// the global order; `forwardPage` slices the probe.
					const page = forwardPage<ContributionNode>(merged, first, encodeCursor);

					return {
						rows: page.rows.map((node) => ({cursor: encodeCursor(node), node})),
						hasNextPage: page.hasNextPage,
						endCursor: page.endCursor,
						totalCount,
					} satisfies ContributionConnection;
				}),
			};
		}),
	);
