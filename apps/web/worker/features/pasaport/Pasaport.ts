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
import {and, eq, inArray, isNull, type SQL, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {forwardPage, keysetAfter} from "../../db/keyset.ts";
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import type {StoredTier} from "../kunye/standing.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import {postVisibleWhere} from "../pano/PostVisibility.ts";
import {
	UserNotFound,
	UsernameAlreadySet,
	type UsernameInvalid,
	UsernameInvalidFormat,
	UsernameTaken,
	UsernameTooLong,
	UsernameTooShort,
} from "./errors.ts";
import {contributionOrdering} from "./ordering.ts";
import {checkUsername} from "./username-rule.ts";

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
	// Server-managed authorship tier (ADR 0107 §4), read here so `Kunye.tierOf`
	// resolves the GLOBAL account-level standing off D1 at the point of use rather
	// than from session state. `çaylak | yazar` only — an account is always ≥ çaylak.
	tier: StoredTier;
}

/**
 * The minimal identity tuple a batched roster read needs per çaylak — the display
 * handle + karma, keyed by `userId`. A projection of {@link ProfileRow} (no counts,
 * no image) for callers that join identity onto many users in ONE read; `username` is
 * nullable here (an un-bootstrapped çaylak has no username yet). See
 * `getProfileIdentitiesByIds`.
 */
export interface ProfileIdentityRow {
	userId: string;
	username: string | null;
	displayName: string | null;
	totalKarma: number;
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

// The shared discriminant + identity fields every contribution variant carries.
// `sandboxed` is the per-item review-state flag (#1316) — `sandboxed_at IS NOT NULL`,
// true only for a çaylak's still-in-review content (and only ever surfaced to the
// author themselves + a moderator, since the feed filters sandboxed rows for anyone
// else). It carries NO reviewer identity — just the item's own lifecycle state — so
// #1291 can key an "incelemede" badge. Always `false` while the authorship loop is
// dark (nothing is sandboxed on create when the flag is off).
interface ContributionBase {
	id: string;
	createdAt: Date;
	score: number;
	sandboxed: boolean;
}

/**
 * The single source of the contribution-union's variant→fields knowledge (the
 * `Contribution` concept is *either* a definition, post, or comment). Each
 * variant lists ONLY its own fields, above {@link ContributionBase}; every other
 * shape — the discriminated {@link ContributionNode}, the flattened
 * {@link ContributionRow}, the runtime null-padding in `shapers`, and the
 * `ContributionView` field map — derives from this map so a variant (or a
 * per-variant field) is declared once (ADR 0018: fate has no union type, so the
 * variants are flattened onto one nullable row — but the membership fact lives
 * here, not spread across four sites).
 */
interface ContributionVariants {
	definition: {bodyExcerpt: string; termSlug: string; termTitle: string};
	post: {title: string; slug: string | null; bodyExcerpt: string | null};
	comment: {bodyExcerpt: string; postId: string; postTitle: string};
}

export type ContributionKind = keyof ContributionVariants;

// `kind` + base + the variant's own fields, per discriminant.
type ContributionNodeOf<K extends ContributionKind> = {kind: K} & ContributionBase &
	ContributionVariants[K];

export type ContributionNode = {[K in ContributionKind]: ContributionNodeOf<K>}[ContributionKind];

// Union of every variant's field names — the columns the flat row flattens onto.
type ContributionVariantField = {
	[K in ContributionKind]: keyof ContributionVariants[K];
}[ContributionKind];

// Each variant field's value type, unioned across the variants that declare it
// (and `null`, since the row nulls every field a given `kind` doesn't own).
type ContributionVariantValue<F extends ContributionVariantField> = {
	[K in ContributionKind]: F extends keyof ContributionVariants[K]
		? ContributionVariants[K][F]
		: never;
}[ContributionKind];

// The variant-field columns, all nullable — the flattened half of the row.
type ContributionVariantColumns = {
	[F in ContributionVariantField]: ContributionVariantValue<F> | null;
};

// Flat **discriminant** reshape of {@link ContributionNode} (ADR 0018: fate has
// no union type). Derived from {@link ContributionVariants}: base fields plus
// every variant's fields made nullable, populated per `kind`.
export type ContributionRow = {kind: ContributionKind} & ContributionBase &
	ContributionVariantColumns;

/**
 * The variant→field-names manifest, the runtime witness of
 * {@link ContributionVariants}. `shapers.toContributionRow` reads it to null-pad
 * generically (every variant column starts `null`, then the node's own fields
 * overlay) — so a forgotten field is a compile-time error here, never a silent
 * wrong-shape in a hand-written `case`. The `satisfies` ties the runtime list to
 * the type-level variant map: drop or misspell a field name and it fails to
 * compile.
 */
export const CONTRIBUTION_VARIANT_FIELDS = {
	definition: ["bodyExcerpt", "termSlug", "termTitle"],
	post: ["title", "slug", "bodyExcerpt"],
	comment: ["bodyExcerpt", "postId", "postTitle"],
} as const satisfies {[K in ContributionKind]: ReadonlyArray<keyof ContributionVariants[K]>};

// Every variant column name, deduped — the keys the flat row nulls then overlays.
export const CONTRIBUTION_VARIANT_FIELD_NAMES: ReadonlyArray<ContributionVariantField> = [
	...new Set(Object.values(CONTRIBUTION_VARIANT_FIELDS).flat() as ContributionVariantField[]),
];

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

export class Pasaport extends Context.Service<
	Pasaport,
	{
		readonly validateSession: (headers: Headers) => Effect.Effect<Session | null, never>;

		readonly getUserById: (userId: string) => Effect.Effect<UserRow | null>;

		// Single `WHERE id IN (...)`; order is not guaranteed (fate re-associates by id).
		readonly getUsersByIds: (userIds: ReadonlyArray<string>) => Effect.Effect<UserRow[]>;

		// Batched identity-only profile read (handle + karma) for many users in ONE
		// `WHERE user_id IN (...)`; the divan roster joins it onto its grouped rows so
		// the client never fires a per-row by-id `Profile` read (#1423). Order is not
		// guaranteed (the caller re-associates by `userId`); users with no profile row
		// are simply absent.
		readonly getProfileIdentitiesByIds: (
			userIds: ReadonlyArray<string>,
		) => Effect.Effect<ProfileIdentityRow[]>;

		readonly setUsername: (input: {
			userId: string;
			value: string;
		}) => Effect.Effect<
			SetUsernameResult,
			UsernameInvalid | UsernameTaken | UsernameAlreadySet | UserNotFound
		>;

		// `viewer` threads the request viewer so the profile's HEADLINE counts
		// (`definitionCount`/`postCount`/`commentCount`) apply the #1205 sandbox filter
		// (#1312): public/anonymous/other-member see counts of the author's LIVE content
		// only, while the author themselves + a moderator see the full count including
		// sandboxed. Omitted ⇒ anonymous (public-only), the fail-safe default — so the
		// headline counts agree with the (#1309-fixed) feed for the same viewer.
		readonly lookupProfile: (
			username: string,
			viewer?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<ProfileRow | null>;

		readonly lookupProfileById: (
			userId: string,
			viewer?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<ProfileRow | null>;

		// The contribution feed for a profile page. `sandboxViewer`/`viewerId` thread
		// the request viewer so the feed applies the #1205 sandbox filter (#1309): a
		// visitor sees only the author's LIVE content, the owner + a moderator also see
		// the author's sandboxed content. Omitted ⇒ anonymous (public-only), the safe
		// default.
		readonly listContributions: (input: {
			authorId: string;
			after?: string | null | undefined;
			first: number;
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
		}) => Effect.Effect<ContributionConnection>;

		// The count of an author's OWN content still in review — sandboxed (#1205)
		// and not removed — the `inReviewCount` aggregate the çaylak-self standing
		// read (#1316) exposes. A bare count over `sandboxBacklogWhere` scoped to the
		// author; it carries no per-item or per-reviewer detail (one-way-glass).
		readonly countInReview: (authorId: string) => Effect.Effect<number>;

		// Account deletion = anonymize-to-`@[silinen]` (ADR 0097). For the calling
		// user, in ONE atomic D1 batch: re-attribute every authored content row to
		// the `silinen` sentinel (content stays Live, karma KEPT), tear down the
		// identity rows (session/account/apikey/verification), and scrub the `user`
		// row to a kept tombstone (PII nulled, `deleted_at` stamped). Idempotent
		// for the same user (re-running re-attributes nothing and re-scrubs the
		// already-scrubbed row). The caller is always the target — there is no
		// "delete user X".
		readonly anonymizeAccount: (input: {userId: string}) => Effect.Effect<void>;

		// Promote a çaylak to yazar (#1206) — the server-side writer of the
		// `input:false` `user.tier` column (#1203). In ONE atomic D1 batch (ADR
		// 0014, the `anonymizeAccount` precedent): flip the tier `çaylak → yazar`
		// AND resolve the account's sandboxed backlog (#1205) — `sandboxed_at := null`
		// on its still-sandboxed, not-removed content, so the now-yazar's backlog goes
		// live. Atomic, so "tier flipped but backlog half-swept" is unrepresentable;
		// idempotent, because both writes are conditional (tier flips only from çaylak,
		// the sweep touches only sandboxed-not-removed rows) so re-running is a no-op.
		// The AUTHORITY (a mod, or a valid vouch) is discharged at the resolver, never
		// here — `promoted: true` iff the tier flip actually fired (the account was a
		// çaylak), `false` on an already-yazar / unknown account.
		readonly promoteToYazar: (input: {userId: string}) => Effect.Effect<{promoted: boolean}>;
	}
>()("@kampus/pasaport/Pasaport") {}

/**
 * The seeded `@[silinen]` sentinel's id + display name (ADR 0097). Migration
 * `0006` seeds the `user` + `user_profile` rows; account-deletion re-attributes
 * content to this id. The reserved username lives in `username-rule.ts`
 * ({@link SILINEN_USERNAME}) — the one place the rule is sourced.
 */
export const SILINEN_USER_ID = "silinen";
export {SILINEN_USERNAME} from "./username-rule.ts";
export const SILINEN_DISPLAY_NAME = "@[silinen]";

// The server-authoritative gate: re-runs the shared {@link checkUsername} rule and
// maps its code onto the typed domain error. The rule (length/charset/reserved) is
// single-sourced in `username-rule.ts`, consumed identically by the SPA forms.
function assertUsername(normalized: string): Effect.Effect<void, UsernameInvalid> {
	switch (checkUsername(normalized)) {
		case "RESERVED":
			return Effect.fail(
				new UsernameInvalidFormat({message: "bu kullanıcı adı ayrılmış ve kullanılamaz"}),
			);
		case "TOO_SHORT":
			return Effect.fail(new UsernameTooShort({message: "kullanıcı adı en az 3 karakter olmalı"}));
		case "TOO_LONG":
			return Effect.fail(
				new UsernameTooLong({message: "kullanıcı adı en fazla 30 karakter olabilir"}),
			);
		case "INVALID_FORMAT":
			return Effect.fail(
				new UsernameInvalidFormat({
					message: "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
				}),
			);
		default:
			return Effect.void;
	}
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
			const {run, batch} = orDieAccess(yield* Drizzle);

			// The per-viewer visibility predicate a count routes through — the ONE seam
			// (ADR 0113), never a by-path-divergent hand-written clause (#1406). The post
			// table folds in the `post_record`-only draft arm (`postVisibleWhere`), so a
			// non-author's count excludes the author's unpublished drafts; definition and
			// comment have no draft dimension and route through `sandboxVisibleWhere`.
			const countVisibleWhere = (
				table:
					| typeof schema.definitionRecord
					| typeof schema.postRecord
					| typeof schema.commentRecord,
				viewer: SandboxViewer,
			): SQL | undefined =>
				table === schema.postRecord
					? postVisibleWhere(
							{sandboxedAt: table.sandboxedAt, authorId: table.authorId, isDraft: table.isDraft},
							viewer,
						)
					: sandboxVisibleWhere({sandboxedAt: table.sandboxedAt, authorId: table.authorId}, viewer);

			// `COUNT(*)` of one author's non-removed rows in a contribution table.
			// Calls `run` directly so callers keep `R = never`. A `viewer` narrows the
			// count to that viewer's sandbox+draft-visible set via `countVisibleWhere`
			// (#1309/#1406) — so the feed's `totalCount` matches the rows it actually
			// returns and never leaks the COUNT of an author's sandboxed/draft content;
			// omitted ⇒ no narrowing.
			const countByAuthor = (
				table:
					| typeof schema.definitionRecord
					| typeof schema.postRecord
					| typeof schema.commentRecord,
				authorId: string,
				viewer?: SandboxViewer,
			): Effect.Effect<number> =>
				run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(table)
						.where(
							and(
								eq(table.authorId, authorId),
								isNull(table.removedAt),
								viewer ? countVisibleWhere(table, viewer) : undefined,
							),
						)
						.then((r) => Number(r[0]?.n ?? 0)),
				);

			// `COUNT(*)` of one author's still-in-review rows in a contribution table:
			// the `sandboxBacklogWhere` read model (#1205) scoped to the author —
			// sandboxed AND not removed. The çaylak-self `inReviewCount` (#1316) sums
			// this across the three tables. Aggregate-only, no per-item leak.
			const countBacklogByAuthor = (
				table:
					| typeof schema.definitionRecord
					| typeof schema.postRecord
					| typeof schema.commentRecord,
				authorId: string,
			): Effect.Effect<number> =>
				run((db) =>
					db
						.select({n: sql<number>`COUNT(*)`})
						.from(table)
						.where(
							sandboxBacklogWhere(
								{
									sandboxedAt: table.sandboxedAt,
									removedAt: table.removedAt,
									authorId: table.authorId,
								},
								{authorId},
							),
						)
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

			// `viewer` is REQUIRED (always a resolved {@link SandboxViewer} — the lookup
			// methods resolve it fail-safe before calling), so the headline counts can
			// never skip the #1205 sandbox filter (#1312). It is passed straight to
			// `countByAuthor`, the SAME viewer-aware count the #1309 feed uses for its
			// `totalCount`, so the header and feed agree per-viewer.
			const hydrateProfile = Effect.fn("Pasaport.hydrateProfile")(function* (
				row: {
					userId: string;
					username: string;
					displayName: string | null;
					image: string | null;
					totalKarma: number;
				},
				viewer: SandboxViewer,
			) {
				const authorId = row.userId;
				const defCount = yield* countByAuthor(schema.definitionRecord, authorId, viewer);
				const postCount = yield* countByAuthor(schema.postRecord, authorId, viewer);
				const commentCount = yield* countByAuthor(schema.commentRecord, authorId, viewer);

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
						tier: row.tier,
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
								tier: row.tier,
							}) satisfies UserRow,
					);
				}),

				getProfileIdentitiesByIds: Effect.fn("Pasaport.getProfileIdentitiesByIds")(function* (
					userIds: ReadonlyArray<string>,
				) {
					if (userIds.length === 0) return [];
					const rows = yield* run((db) =>
						db
							.select({
								userId: schema.userProfile.userId,
								username: schema.userProfile.username,
								displayName: schema.userProfile.displayName,
								totalKarma: schema.userProfile.totalKarma,
							})
							.from(schema.userProfile)
							.where(inArray(schema.userProfile.userId, [...userIds])),
					);
					return rows.map(
						(row) =>
							({
								userId: row.userId,
								username: row.username ?? null,
								displayName: row.displayName ?? null,
								totalKarma: row.totalKarma,
							}) satisfies ProfileIdentityRow,
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

				lookupProfile: Effect.fn("Pasaport.lookupProfile")(function* (
					username: string,
					viewer?: {
						viewerId?: string | null | undefined;
						sandboxViewer?: SandboxViewer | undefined;
					},
				) {
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
					// Resolve the viewer fail-safe (missing ⇒ anonymous) so the counts are
					// never computed sandbox-blind (#1312).
					return yield* hydrateProfile(
						{...row, username: row.username},
						resolveSandboxViewer(viewer ?? {}),
					);
				}),

				lookupProfileById: Effect.fn("Pasaport.lookupProfileById")(function* (
					userId: string,
					viewer?: {
						viewerId?: string | null | undefined;
						sandboxViewer?: SandboxViewer | undefined;
					},
				) {
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
					return yield* hydrateProfile(
						{...row, username: row.username},
						resolveSandboxViewer(viewer ?? {}),
					);
				}),

				countInReview: Effect.fn("Pasaport.countInReview")(function* (authorId: string) {
					const defs = yield* countBacklogByAuthor(schema.definitionRecord, authorId);
					const posts = yield* countBacklogByAuthor(schema.postRecord, authorId);
					const comments = yield* countBacklogByAuthor(schema.commentRecord, authorId);
					return defs + posts + comments;
				}),

				listContributions: Effect.fn("Pasaport.listContributions")(function* (input: {
					authorId: string;
					after?: string | null | undefined;
					first: number;
					viewerId?: string | null | undefined;
					sandboxViewer?: SandboxViewer | undefined;
				}) {
					const first = Math.max(1, Math.min(input.first, 50));
					const cursor = input.after ? decodeCursor(input.after) : null;
					const fetchSize = first + 1;

					// The #1205 sandbox filter, resolved against the request viewer (#1309):
					// the profile feed shows the author's LIVE content to everyone, but the
					// author's SANDBOXED content only to the author themselves + a moderator.
					// A missing viewer resolves to anonymous, so the default is public-only.
					const viewer = resolveSandboxViewer(input);

					// `after` present but undecodable is a cursor miss → empty page.
					const cursorMissed = input.after != null && cursor === null;

					// Per-table keyset for the global `(created_at desc, id desc)` merge.
					// The predicate and the `.orderBy(…)` both derive from the per-table
					// `contributionOrdering`; null cursor values (no `after`) collapse the
					// predicate to undefined so only the base author/removed filter applies.
					function keysetWhere(
						table:
							| typeof schema.definitionRecord
							| typeof schema.postRecord
							| typeof schema.commentRecord,
					) {
						const base = and(
							eq(table.authorId, input.authorId),
							isNull(table.removedAt),
							sandboxVisibleWhere(
								{sandboxedAt: table.sandboxedAt, authorId: table.authorId},
								viewer,
							),
						);
						const predicate = keysetAfter(
							keysetKeys(contributionOrdering(table), (field) =>
								field === "id" ? (cursor?.id ?? null) : (cursor?.createdAt ?? null),
							),
						);
						return predicate ? and(base, predicate) : base;
					}

					const defs = yield* run((db) =>
						db
							.select({
								id: schema.definitionRecord.id,
								createdAt: schema.definitionRecord.createdAt,
								score: schema.definitionRecord.score,
								sandboxedAt: schema.definitionRecord.sandboxedAt,
								bodyExcerpt: schema.definitionRecord.bodyExcerpt,
								termSlug: schema.definitionRecord.termSlug,
								termTitle: schema.definitionRecord.termTitle,
							})
							.from(schema.definitionRecord)
							.where(keysetWhere(schema.definitionRecord))
							.orderBy(...orderByColumns(contributionOrdering(schema.definitionRecord)))
							.limit(fetchSize),
					);

					const posts = yield* run((db) =>
						db
							.select({
								id: schema.postRecord.id,
								slug: schema.postRecord.slug,
								createdAt: schema.postRecord.createdAt,
								score: schema.postRecord.score,
								sandboxedAt: schema.postRecord.sandboxedAt,
								title: schema.postRecord.title,
								bodyExcerpt: schema.postRecord.bodyExcerpt,
							})
							.from(schema.postRecord)
							.where(keysetWhere(schema.postRecord))
							.orderBy(...orderByColumns(contributionOrdering(schema.postRecord)))
							.limit(fetchSize),
					);

					const comments = yield* run((db) =>
						db
							.select({
								id: schema.commentRecord.id,
								createdAt: schema.commentRecord.createdAt,
								score: schema.commentRecord.score,
								sandboxedAt: schema.commentRecord.sandboxedAt,
								bodyExcerpt: schema.commentRecord.bodyExcerpt,
								postId: schema.commentRecord.postId,
								postTitle: schema.commentRecord.postTitle,
							})
							.from(schema.commentRecord)
							.where(keysetWhere(schema.commentRecord))
							.orderBy(...orderByColumns(contributionOrdering(schema.commentRecord)))
							.limit(fetchSize),
					);

					const defTotal = yield* countByAuthor(schema.definitionRecord, input.authorId, viewer);
					const postTotal = yield* countByAuthor(schema.postRecord, input.authorId, viewer);
					const commentTotal = yield* countByAuthor(schema.commentRecord, input.authorId, viewer);
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
							sandboxed: d.sandboxedAt != null,
							bodyExcerpt: d.bodyExcerpt,
							termSlug: d.termSlug,
							termTitle: d.termTitle,
						})),
						...posts.map<ContributionNode>((p) => ({
							kind: "post",
							id: p.id,
							createdAt: p.createdAt ?? new Date(0),
							score: p.score,
							sandboxed: p.sandboxedAt != null,
							title: p.title,
							slug: p.slug,
							bodyExcerpt: p.bodyExcerpt,
						})),
						...comments.map<ContributionNode>((c) => ({
							kind: "comment",
							id: c.id,
							createdAt: c.createdAt ?? new Date(0),
							score: c.score,
							sandboxed: c.sandboxedAt != null,
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

				anonymizeAccount: Effect.fn("Pasaport.anonymizeAccount")(function* (input: {
					userId: string;
				}) {
					const {userId} = input;
					const now = new Date();
					// `verification` keys by `identifier` = the live email, which the batch
					// is about to scrub — so capture it as a plain value BEFORE the batch
					// (ADR 0097 §2) and delete by that literal, never a correlated subquery
					// (D1's batch executor rejects a raw subquery member).
					const user = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					const email = user?.email ?? null;
					// One atomic batch (ADR 0014/0097 §2): every statement commits or none
					// does, so the world never sees a half-anonymized account.
					yield* batch((db) => buildAnonymizeStatements(db, userId, email, now));
				}),

				promoteToYazar: Effect.fn("Pasaport.promoteToYazar")(function* (input: {userId: string}) {
					const now = new Date();
					// One atomic batch (ADR 0014, the `anonymizeAccount` precedent): the
					// tier flip and the backlog sweep commit together or not at all, so a
					// half-swept promotion (tier flipped, backlog still sandboxed — or the
					// reverse) is unrepresentable. The first statement is the conditional
					// tier UPDATE; its `changes` count is `1` iff the account was a çaylak.
					const result = yield* batch((db) => buildPromotionStatements(db, input.userId, now));
					return {promoted: result[0].meta.changes > 0};
				}),
			};
		}),
	);

/**
 * The atomic teardown of one account (ADR 0097 §2). In order:
 *  1–3. Re-attribute the user's content (`definition_record` / `post_record` /
 *       `comment_record`): `author_id := silinen`, denormalized `author_name`
 *       overwritten. Content stays Live (`removed_at` untouched) — this is
 *       re-attribution, not removal — so its votes/scores and the karma they
 *       earned ride along untouched.
 *  4–7. Tear down the identity rows: `session` / `account` / `apikey` /
 *       `verification`. `verification` keys by `identifier` = the user's email
 *       (not a FK), so it's deleted by the literal email the caller resolved
 *       before this batch; skipped when the user has no email.
 *  8.   Scrub the `user` row to a kept tombstone: PII (email/name/image) nulled,
 *       `deleted_at` stamped. The row is KEPT so the `author_id → silinen`
 *       redirect and FKs stay coherent and the email can re-register fresh.
 *
 * Every statement is a query-builder statement (no raw correlated subquery) so
 * D1's `batch()` executor accepts the whole array.
 */
function buildAnonymizeStatements(db: DrizzleDb, userId: string, email: string | null, now: Date) {
	const reattributeDefs = db
		.update(schema.definitionRecord)
		.set({authorId: SILINEN_USER_ID, authorName: SILINEN_DISPLAY_NAME, updatedAt: now})
		.where(eq(schema.definitionRecord.authorId, userId));

	const reattributePosts = db
		.update(schema.postRecord)
		.set({authorId: SILINEN_USER_ID, authorName: SILINEN_DISPLAY_NAME, updatedAt: now})
		.where(eq(schema.postRecord.authorId, userId));

	const reattributeComments = db
		.update(schema.commentRecord)
		.set({authorId: SILINEN_USER_ID, authorName: SILINEN_DISPLAY_NAME, updatedAt: now})
		.where(eq(schema.commentRecord.authorId, userId));

	const dropSessions = db.delete(schema.session).where(eq(schema.session.userId, userId));
	const dropAccounts = db.delete(schema.account).where(eq(schema.account.userId, userId));
	const dropApikeys = db.delete(schema.apikey).where(eq(schema.apikey.userId, userId));

	const scrubUser = db
		.update(schema.user)
		.set({name: null, email: "", image: null, deletedAt: now, updatedAt: now})
		.where(eq(schema.user.id, userId));

	const dropVerification = email
		? [db.delete(schema.verification).where(eq(schema.verification.identifier, email))]
		: [];

	return [
		reattributeDefs,
		reattributePosts,
		reattributeComments,
		...dropVerification,
		dropSessions,
		dropAccounts,
		dropApikeys,
		scrubUser,
	] as const;
}

/**
 * The atomic çaylak→yazar promotion (#1206). In order:
 *  1.   Flip `user.tier` `çaylak → yazar`. The `tier = 'çaylak'` WHERE is the
 *       idempotency guard: an already-yazar (or unknown) account matches 0 rows, so
 *       re-running promotes nothing — and it is the read of `changes` that reports
 *       `promoted`.
 *  2–4. Resolve the account's sandboxed backlog (#1205): `sandboxed_at := null` on
 *       its definitions / posts / comments that are still sandboxed and not removed.
 *       The WHERE is exactly the #1205 {@link sandboxBacklogWhere} read model scoped
 *       to this author, so the sweep flips precisely the rows the moderator queue
 *       showed — leaving live rows (already null) and removed rows (`removed_at` set)
 *       untouched, so a mixed backlog lands consistent and a re-run is a no-op.
 *
 * Every statement is a query-builder statement (no raw correlated subquery) so D1's
 * `batch()` executor accepts the whole array (the `buildAnonymizeStatements` rule).
 */
function buildPromotionStatements(db: DrizzleDb, userId: string, now: Date) {
	const promoteTier = db
		.update(schema.user)
		.set({tier: "yazar", updatedAt: now})
		.where(and(eq(schema.user.id, userId), eq(schema.user.tier, "çaylak")));

	const sweep = (
		table: typeof schema.definitionRecord | typeof schema.postRecord | typeof schema.commentRecord,
	) =>
		db
			.update(table)
			.set({sandboxedAt: null, updatedAt: now})
			.where(
				sandboxBacklogWhere(
					{sandboxedAt: table.sandboxedAt, removedAt: table.removedAt, authorId: table.authorId},
					{authorId: userId},
				),
			);

	return [
		promoteTier,
		sweep(schema.definitionRecord),
		sweep(schema.postRecord),
		sweep(schema.commentRecord),
	] as const;
}
