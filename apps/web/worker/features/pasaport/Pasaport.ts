/**
 * Pasaport — the user identity + profile service. Every internal DB call dies on
 * `DrizzleError` (`orDieAccess` at layer build), so the public signatures carry
 * domain errors only. Validation lives inside the methods (ADR 0013).
 */
import type {Auth as BetterAuth} from "better-auth";
import {and, desc, eq, inArray, isNull, like, or, type SQL, sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {
	emptyKeysetPage,
	forwardPage,
	type KeysetPage,
	keysetAfter,
	resolveCursor,
} from "../../db/keyset.ts";
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import {moderatorTuple, type PlatformRole} from "../kunye/moderate.ts";
import type {StoredTier} from "../kunye/standing.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import {postVisibleWhere} from "../pano/PostVisibility.ts";
import {
	type BanEvent,
	type BanState,
	NOT_BANNED,
	resolveBanState,
	selectBanStates,
	type UserBanEvent,
} from "./ban.ts";
import {
	DELIVERABLE,
	type EmailDeliveryEvent,
	type EmailDeliveryEventRow,
	type EmailDeliveryState,
	type FailingAddress,
	resolveEmailDeliveryState,
	selectFailingAddresses,
} from "./email-delivery.ts";
import {
	DisplayNameEmpty,
	UserNotFound,
	UsernameAlreadySet,
	type UsernameInvalid,
	UsernameInvalidFormat,
	UsernameTaken,
	UsernameTooLong,
	UsernameTooShort,
} from "./errors.ts";
import {contributionOrdering} from "./ordering.ts";
import type {ProfileRow} from "./profile-fields.ts";
import {NO_SANDBOX_SWEEP, type SandboxSweep} from "./sandbox-sweep.ts";
import {toUserRow, type UserRow} from "./user-fields.ts";
import {checkUsername, normalizeUsername} from "./username-rule.ts";

export type {ProfileRow} from "./profile-fields.ts";
export type {UserRow} from "./user-fields.ts";

// The worker-level better-auth handle, NOT the per-request session — that is
// `CurrentUser` (ADR 0042).
export type BetterAuthInstance = BetterAuth;
export type Session = NonNullable<Awaited<ReturnType<BetterAuthInstance["api"]["getSession"]>>>;

// Identity-only projection of {@link ProfileRow} for batched roster reads;
// `username` is null for an un-bootstrapped çaylak.
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

export interface SetDisplayNameResult {
	userId: string;
	username: string | null;
	displayName: string;
	image: string | null;
}

// `sandboxed` = `sandboxed_at IS NOT NULL` (#1316). It carries NO reviewer identity,
// and the feed only ever surfaces a sandboxed row to its author + a moderator.
interface ContributionBase {
	id: string;
	createdAt: Date;
	score: number;
	sandboxed: boolean;
}

// The single source of variant→fields for the contribution union: every other shape
// (node, flat row, shaper null-padding, view field map) derives from this map, so add
// a variant or a field here and nowhere else. See ADR 0018.
interface ContributionVariants {
	definition: {bodyExcerpt: string; termSlug: string; termTitle: string};
	post: {title: string; slug: string | null; bodyExcerpt: string | null};
	comment: {bodyExcerpt: string; postId: string; postTitle: string};
}

export type ContributionKind = keyof ContributionVariants;

type ContributionNodeOf<K extends ContributionKind> = {kind: K} & ContributionBase &
	ContributionVariants[K];

export type ContributionNode = {[K in ContributionKind]: ContributionNodeOf<K>}[ContributionKind];

type ContributionVariantField = {
	[K in ContributionKind]: keyof ContributionVariants[K];
}[ContributionKind];

type ContributionVariantValue<F extends ContributionVariantField> = {
	[K in ContributionKind]: F extends keyof ContributionVariants[K]
		? ContributionVariants[K][F]
		: never;
}[ContributionKind];

type ContributionVariantColumns = {
	[F in ContributionVariantField]: ContributionVariantValue<F> | null;
};

// Flat discriminant reshape of {@link ContributionNode} — see ADR 0018 (fate has no
// union type).
export type ContributionRow = {kind: ContributionKind} & ContributionBase &
	ContributionVariantColumns;

// Runtime witness of {@link ContributionVariants} — `shapers.toContributionRow`
// reads it to null-pad generically. The `satisfies` makes a missed field a compile
// error rather than a silent wrong-shape row.
export const CONTRIBUTION_VARIANT_FIELDS = {
	definition: ["bodyExcerpt", "termSlug", "termTitle"],
	post: ["title", "slug", "bodyExcerpt"],
	comment: ["bodyExcerpt", "postId", "postTitle"],
} as const satisfies {[K in ContributionKind]: ReadonlyArray<keyof ContributionVariants[K]>};

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

// `address` is the server-resolved projection key, returned alongside `state` so the
// resolver keys its ack without a second user lookup (epic #2687).
export interface EmailDeliveryResult {
	readonly address: string;
	readonly state: EmailDeliveryState;
}

export class Pasaport extends Context.Service<
	Pasaport,
	{
		readonly validateSession: (headers: Headers) => Effect.Effect<Session | null, never>;

		readonly getUserById: (userId: string) => Effect.Effect<UserRow | null>;

		// Single `WHERE id IN (...)`; order is not guaranteed (fate re-associates by id).
		readonly getUsersByIds: (userIds: ReadonlyArray<string>) => Effect.Effect<UserRow[]>;

		// Order is not guaranteed (the caller re-associates by `userId`); users with no
		// profile row are simply absent.
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

		// Writes `user.name` AND `user_profile.display_name` in ONE atomic D1 batch so
		// the two can never diverge (#2154). Unlike `setUsername`, re-runnable.
		readonly setDisplayName: (input: {
			userId: string;
			value: string;
		}) => Effect.Effect<SetDisplayNameResult, DisplayNameEmpty | UserNotFound>;

		// `viewer` applies the #1205 sandbox filter to the headline counts (#1312):
		// only the author + a moderator see sandboxed content counted. Omitted ⇒
		// anonymous (public-only), the fail-safe default.
		readonly lookupProfile: (
			username: string,
			viewer?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<ProfileRow | null>;

		readonly lookupProfileById: (
			userId: string,
			viewer?: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined},
		) => Effect.Effect<ProfileRow | null>;

		// Same #1205 sandbox filter as `lookupProfile` (#1309). Omitted viewer ⇒
		// anonymous (public-only), the safe default.
		readonly listContributions: (input: {
			authorId: string;
			after?: string | null | undefined;
			first: number;
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
		}) => Effect.Effect<ContributionConnection>;

		// Aggregate only — no per-item or per-reviewer detail (one-way-glass, #1316).
		readonly countInReview: (authorId: string) => Effect.Effect<number>;

		// Account deletion = anonymize-to-`@[silinen]`; see ADR 0097. Idempotent, and
		// the caller is always the target — there is no "delete user X".
		readonly anonymizeAccount: (input: {userId: string}) => Effect.Effect<void>;

		// Tier flip + sandbox-backlog sweep in ONE atomic D1 batch, idempotent (#1206).
		// The AUTHORITY (a mod, or a valid vouch) is discharged at the resolver, never
		// here. `promoted: true` iff the tier flip actually fired, and `sweep` names the
		// live topics whose subscribers must re-read the rows it un-sandboxed (#6462) —
		// empty on a no-op flip, since nothing moved.
		readonly promoteToYazar: (input: {
			userId: string;
		}) => Effect.Effect<{promoted: boolean; sweep: SandboxSweep}>;

		// A FRESH read of the append-only `user_ban_event` log, never a cached session
		// flag (epic #968).
		readonly getBanState: (userId: string) => Effect.Effect<BanState>;

		// The audit record IS the write (ADR 0107, epic #968). The AUTHORITY is
		// discharged at the resolver (`requireAdmin`), never here.
		readonly banUser: (input: {
			userId: string;
			actorId: string;
			reason: string;
			expiresAt?: Date | null;
		}) => Effect.Effect<BanState, UserNotFound>;

		// Idempotent — unbanning a not-banned account appends a benign `unban`.
		readonly unbanUser: (input: {
			userId: string;
			actorId: string;
		}) => Effect.Effect<BanState, UserNotFound>;

		// The `(userId, "moderates", platform)` tuple write IS the authority change
		// (`isModerator` / `moderatorsAmong` re-read it); `user_role_event` is the audit
		// trail. The AUTHORITY to call this is discharged at the resolver
		// (`requireAdmin`), never here. See ADR 0107.
		readonly setRole: (input: {
			userId: string;
			actorId: string;
			role: PlatformRole;
		}) => Effect.Effect<{readonly role: PlatformRole}, UserNotFound>;

		// A fresh read of the append-only `email_delivery_event` log — the same
		// projection the admin roll-up and the send-time capture feed, so "marked
		// failing" and "reported failing" can't disagree (epic #2687).
		readonly getEmailDeliveryState: (
			userId: string,
		) => Effect.Effect<EmailDeliveryResult, UserNotFound>;

		// An out-of-band bounce an admin learns of shares the SAME log the send-time
		// capture writes (#2692/#2734). The AUTHORITY is discharged at the resolver
		// (`requireAdmin`), never here.
		readonly markEmailFailing: (input: {
			userId: string;
			actorId: string;
			reason: string;
		}) => Effect.Effect<EmailDeliveryResult, UserNotFound>;

		// Appends a `clear` without mutating the `fail` row (full reversibility, as in
		// unban). Idempotent.
		readonly clearEmailFailing: (input: {
			userId: string;
			actorId: string;
		}) => Effect.Effect<EmailDeliveryResult, UserNotFound>;

		// Derived from the log, never a stored flag. Read only past `requireAdmin`.
		readonly listFailingAddresses: () => Effect.Effect<ReadonlyArray<FailingAddress>>;

		// Record-derived fields only — ban-state, role and moderator standing are joined
		// by the resolver ({@link banStatesForAdmin} + `moderatorsAmong`), never read off
		// the retired `user.role` column. Read only past `requireAdmin`. Keyset envelope:
		// .patterns/fate-connections.md
		readonly listUsersForAdmin: (opts: {
			search?: string | null;
			first?: number;
			after?: string | null;
		}) => Effect.Effect<KeysetPage<AdminUserRow>>;

		// One query for the whole roster page, so it never runs a per-row `getBanState`
		// (an in-page N+1). A missing id is absent from the map, meaning {@link NOT_BANNED}.
		readonly banStatesForAdmin: (
			ids: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, BanState>>;
	}
>()("@kampus/pasaport/Pasaport") {}

// `createdAt` is nullable because the founding cohort predates the column; the
// feature's shaper converts it to an epoch-millis wire scalar.
export interface AdminUserRow {
	readonly id: string;
	readonly username: string | null;
	readonly email: string;
	readonly tier: StoredTier;
	readonly createdAt: Date | null;
}

// The seeded `@[silinen]` sentinel (ADR 0097); migration `0006` seeds its rows. The
// reserved username itself is sourced in `username-rule.ts`.
export const SILINEN_USER_ID = "silinen";
export {SILINEN_USERNAME} from "./username-rule.ts";
export const SILINEN_DISPLAY_NAME = "@[silinen]";

// The server-authoritative gate. The rule itself is single-sourced in
// `username-rule.ts`, consumed identically by the SPA forms.
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

// Wire format `<epochSeconds>:<id>` for the `(createdAt desc, id desc)` keyset.
// Epoch SECONDS, because D1 stores `created_at` as `integer({mode:"timestamp"})` —
// matching the DB's granularity keeps the keyset lossless across deploys.
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

// Takes the already-resolved better-auth instance: sharing the one instance with the
// `/api/auth/*` route keeps session cookies signed and validated by the same secret.
export const makePasaportLive = (auth: BetterAuthInstance) =>
	Layer.effect(Pasaport)(
		Effect.gen(function* () {
			const {run, batch} = orDieAccess(yield* Drizzle);

			// The ONE seam every count routes through, never a hand-written clause that
			// can diverge by path (ADR 0113, #1406). Only `post_record` has a draft
			// dimension, hence the split.
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

			// A `viewer` narrows the count to that viewer's visible set, so `totalCount`
			// matches the rows actually returned and never leaks a count of the author's
			// sandboxed/draft content (#1309/#1406). Omitted ⇒ no narrowing.
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

			// `viewer` is REQUIRED, not optional, so the headline counts can never skip
			// the #1205 sandbox filter (#1312); callers resolve it fail-safe first.
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

			// The session boundary and the admin ban surface both route through this one
			// seam, so "session refused" and "reported banned" can't disagree. `now` is
			// fresh per call so an expiry self-lifts.
			const readBanState = (userId: string): Effect.Effect<BanState> =>
				run((db) =>
					db
						.select({
							action: schema.userBanEvent.action,
							reason: schema.userBanEvent.reason,
							expiresAt: schema.userBanEvent.expiresAt,
							createdAt: schema.userBanEvent.createdAt,
						})
						.from(schema.userBanEvent)
						.where(eq(schema.userBanEvent.userId, userId))
						.orderBy(desc(schema.userBanEvent.createdAt), desc(schema.userBanEvent.id))
						.limit(1)
						.then((rows): BanState => {
							const row = rows[0];
							if (!row) return NOT_BANNED;
							const latest: BanEvent = {
								action: row.action,
								reason: row.reason,
								expiresAt: row.expiresAt,
								createdAt: row.createdAt ?? new Date(0),
							};
							return resolveBanState(latest, new Date());
						}),
				);

			// Keyed by ADDRESS, not user id (index-backed by
			// `email_delivery_event_address_created`), so the mark/clear ack, the
			// per-target read and the roll-up all resolve the same latest-event-wins truth.
			const readEmailDeliveryState = (address: string): Effect.Effect<EmailDeliveryState> =>
				run((db) =>
					db
						.select({
							action: schema.emailDeliveryEvent.action,
							reason: schema.emailDeliveryEvent.reason,
							createdAt: schema.emailDeliveryEvent.createdAt,
						})
						.from(schema.emailDeliveryEvent)
						.where(eq(schema.emailDeliveryEvent.address, address))
						.orderBy(desc(schema.emailDeliveryEvent.createdAt), desc(schema.emailDeliveryEvent.id))
						.limit(1)
						.then((rows): EmailDeliveryState => {
							const row = rows[0];
							if (!row) return DELIVERABLE;
							const latest: EmailDeliveryEvent = {
								action: row.action,
								reason: row.reason,
								createdAt: row.createdAt ?? new Date(0),
							};
							return resolveEmailDeliveryState(latest, new Date());
						}),
				);

			// Rejects an unknown target up front so a mark/clear can't be recorded against
			// a non-existent id (the audit log stays meaningful). Only the admin mark/clear
			// calls this, so `actorId` is always a real admin (#2734) — the send-time
			// capture writes its actor-less rows through `EmailDeliveryLog` instead.
			const appendEmailDeliveryEvent = (
				userId: string,
				actorId: string,
				action: EmailDeliveryEvent["action"],
				reason: string | null,
			): Effect.Effect<EmailDeliveryResult, UserNotFound> =>
				Effect.gen(function* () {
					const target = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					if (!target) return yield* new UserNotFound({message: "kullanıcı bulunamadı"});
					yield* run((db) =>
						db.insert(schema.emailDeliveryEvent).values({
							id: crypto.randomUUID(),
							userId,
							actorId,
							address: target.email,
							action,
							reason,
							createdAt: new Date(),
						}),
					);
					return {address: target.email, state: yield* readEmailDeliveryState(target.email)};
				});

			return {
				validateSession: Effect.fn("Pasaport.validateSession")(function* (headers: Headers) {
					// better-auth's `getSession` can throw on a flaky JWT, missing
					// cookie, etc. Treat any failure as "no session" (log + swallow).
					const session = yield* Effect.tryPromise({
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
					// A banned account's session is REFUSED here, not merely flagged — every
					// session-derived consumer reads this one gate, so a still-valid cookie
					// reads as anonymous and an unban restores access on the next request. The
					// ban-state is read FRESH from D1, never trusted off the session token
					// (the fail-closed fresh-read invariant of ADR 0098 §2).
					if (session?.user) {
						const banState = yield* readBanState(session.user.id);
						if (banState.banned) return null;
					}
					return session;
				}),

				getUserById: Effect.fn("Pasaport.getUserById")(function* (userId: string) {
					const row = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					if (!row) return null;
					return toUserRow(row);
				}),

				getUsersByIds: Effect.fn("Pasaport.getUsersByIds")(function* (
					userIds: ReadonlyArray<string>,
				) {
					if (userIds.length === 0) return [];
					const rows = yield* run((db) =>
						db.query.user.findMany({where: {id: {in: [...userIds]}}}),
					);
					return rows.map(toUserRow);
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
					const normalized = normalizeUsername(input.value);
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

				setDisplayName: Effect.fn("Pasaport.setDisplayName")(function* (input: {
					userId: string;
					value: string;
				}) {
					const {userId} = input;
					const trimmed = input.value.trim();
					if (trimmed.length === 0) {
						return yield* new DisplayNameEmpty({message: "görünen ad boş olamaz"});
					}

					const existingUser = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					if (!existingUser) {
						return yield* new UserNotFound({message: "kullanıcı bulunamadı"});
					}

					const now = new Date();
					// One atomic batch: `user.name` and `user_profile.display_name` move
					// all-or-none, so a byline can never render a name the settings surface
					// has already changed (#2154).
					yield* batch((db) => buildSetDisplayNameStatements(db, userId, trimmed, now));

					return {
						userId,
						username: existingUser.username ?? null,
						displayName: trimmed,
						image: existingUser.image ?? null,
					} satisfies SetDisplayNameResult;
				}),

				lookupProfile: Effect.fn("Pasaport.lookupProfile")(function* (
					username: string,
					viewer?: {
						viewerId?: string | null | undefined;
						sandboxViewer?: SandboxViewer | undefined;
					},
				) {
					// Usernames are stored lowercased at write time, so the read must
					// normalize identically or a mixed-case `/u/Rasit` misses the stored
					// `rasit` row and 404s (#2445).
					const normalized = normalizeUsername(username);
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
							.where(eq(schema.userProfile.username, normalized))
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

					// A missing viewer resolves to anonymous, so the default is public-only
					// (#1205/#1309).
					const viewer = resolveSandboxViewer(input);

					const cursorMissed = input.after != null && cursor === null;

					// Per-table keyset for the global `(created_at desc, id desc)` merge; a
					// null cursor collapses the predicate so only the base filter applies.
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

					// Each table is read with `LIMIT first+1` under the same keyset, so the
					// merged set holds every candidate for the next `first` slots of the
					// global order.
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
					// `verification` keys by `identifier` = the live email, which the batch is
					// about to scrub — so capture it as a plain value BEFORE the batch and
					// delete by that literal, never a correlated subquery (D1's batch
					// executor rejects a raw subquery member). See ADR 0097 §2.
					const user = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					const email = user?.email ?? null;
					yield* batch((db) => buildAnonymizeStatements(db, userId, email, now));
				}),

				promoteToYazar: Effect.fn("Pasaport.promoteToYazar")(function* (input: {userId: string}) {
					const now = new Date();
					const sweep = yield* run((db) => readSandboxSweep(db, input.userId));
					// One atomic batch, so a half-swept promotion is unrepresentable (ADR
					// 0014). The first statement is the conditional tier UPDATE; its
					// `changes` count is `1` iff the account was a çaylak.
					const result = yield* batch((db) => buildPromotionStatements(db, input.userId, now));
					const promoted = result[0].meta.changes > 0;
					return {promoted, sweep: promoted ? sweep : NO_SANDBOX_SWEEP};
				}),

				getBanState: Effect.fn("Pasaport.getBanState")(function* (userId: string) {
					return yield* readBanState(userId);
				}),

				banUser: Effect.fn("Pasaport.banUser")(function* (input: {
					userId: string;
					actorId: string;
					reason: string;
					expiresAt?: Date | null;
				}) {
					// Reject an unknown target up front so a ban can't be recorded against a
					// non-existent id (the audit log stays meaningful).
					const target = yield* run((db) => db.query.user.findFirst({where: {id: input.userId}}));
					if (!target) return yield* new UserNotFound({message: "kullanıcı bulunamadı"});

					yield* run((db) =>
						db.insert(schema.userBanEvent).values({
							id: crypto.randomUUID(),
							userId: input.userId,
							action: "ban",
							actorId: input.actorId,
							reason: input.reason,
							expiresAt: input.expiresAt ?? null,
							createdAt: new Date(),
						}),
					);
					return yield* readBanState(input.userId);
				}),

				unbanUser: Effect.fn("Pasaport.unbanUser")(function* (input: {
					userId: string;
					actorId: string;
				}) {
					const target = yield* run((db) => db.query.user.findFirst({where: {id: input.userId}}));
					if (!target) return yield* new UserNotFound({message: "kullanıcı bulunamadı"});

					yield* run((db) =>
						db.insert(schema.userBanEvent).values({
							id: crypto.randomUUID(),
							userId: input.userId,
							action: "unban",
							actorId: input.actorId,
							reason: null,
							expiresAt: null,
							createdAt: new Date(),
						}),
					);
					return yield* readBanState(input.userId);
				}),

				setRole: Effect.fn("Pasaport.setRole")(function* (input: {
					userId: string;
					actorId: string;
					role: PlatformRole;
				}) {
					// Reject an unknown target up front so the audit log stays meaningful.
					const target = yield* run((db) => db.query.user.findFirst({where: {id: input.userId}}));
					if (!target) return yield* new UserNotFound({message: "kullanıcı bulunamadı"});

					// Encoded through kunye's `moderatorTuple` so this write can't drift from
					// the `isModerator` / `moderatorsAmong` read.
					const tuple = moderatorTuple(input.userId);
					yield* run((db) =>
						input.role === "moderator"
							? db.insert(schema.relationTuple).values(tuple).onConflictDoNothing()
							: db
									.delete(schema.relationTuple)
									.where(
										and(
											eq(schema.relationTuple.subject, tuple.subject),
											eq(schema.relationTuple.relation, tuple.relation),
											eq(schema.relationTuple.object, tuple.object),
										),
									),
					);

					yield* run((db) =>
						db.insert(schema.userRoleEvent).values({
							id: crypto.randomUUID(),
							userId: input.userId,
							role: input.role,
							actorId: input.actorId,
							createdAt: new Date(),
						}),
					);
					return {role: input.role};
				}),

				getEmailDeliveryState: Effect.fn("Pasaport.getEmailDeliveryState")(function* (
					userId: string,
				) {
					const target = yield* run((db) => db.query.user.findFirst({where: {id: userId}}));
					if (!target) return yield* new UserNotFound({message: "kullanıcı bulunamadı"});
					return {address: target.email, state: yield* readEmailDeliveryState(target.email)};
				}),

				markEmailFailing: Effect.fn("Pasaport.markEmailFailing")(function* (input: {
					userId: string;
					actorId: string;
					reason: string;
				}) {
					return yield* appendEmailDeliveryEvent(input.userId, input.actorId, "fail", input.reason);
				}),

				clearEmailFailing: Effect.fn("Pasaport.clearEmailFailing")(function* (input: {
					userId: string;
					actorId: string;
				}) {
					return yield* appendEmailDeliveryEvent(input.userId, input.actorId, "clear", null);
				}),

				listFailingAddresses: Effect.fn("Pasaport.listFailingAddresses")(function* () {
					// The failure log is small (only send rejections + admin marks land here),
					// so read it whole and reduce in the pure projection rather than write a
					// second group-wise-latest SQL that could drift from the per-address read.
					const rows = yield* run((db) =>
						db
							.select({
								id: schema.emailDeliveryEvent.id,
								userId: schema.emailDeliveryEvent.userId,
								address: schema.emailDeliveryEvent.address,
								action: schema.emailDeliveryEvent.action,
								reason: schema.emailDeliveryEvent.reason,
								createdAt: schema.emailDeliveryEvent.createdAt,
							})
							.from(schema.emailDeliveryEvent),
					);
					const events: ReadonlyArray<EmailDeliveryEventRow> = rows.map((row) => ({
						id: row.id,
						userId: row.userId,
						address: row.address,
						action: row.action,
						reason: row.reason,
						createdAt: row.createdAt ?? new Date(0),
					}));
					return selectFailingAddresses(events, new Date());
				}),

				listUsersForAdmin: Effect.fn("Pasaport.listUsersForAdmin")(function* (opts: {
					search?: string | null;
					first?: number;
					after?: string | null;
				}) {
					const first = Math.max(1, Math.min(opts.first ?? 25, 100));
					const after = opts.after ?? null;
					const term = opts.search?.trim().toLowerCase();

					// No `lower()` wrap: SQLite `LIKE` is already case-insensitive for ASCII,
					// and these columns are ASCII by rule.
					const searchWhere =
						term && term.length > 0
							? or(
									like(schema.user.username, `%${term}%`),
									like(schema.user.email, `%${term}%`),
									like(schema.user.name, `%${term}%`),
								)
							: undefined;

					// Exclude the seeded `@[silinen]` sentinel + scrubbed tombstones (ADR 0097):
					// a `deleted_at` row is not a real account an admin manages.
					const baseWhere = and(isNull(schema.user.deletedAt), searchWhere);

					// A cursor that no longer points at a live row yields the empty page; the
					// DB read is the port, `resolveCursor` the pure decision (ADR 0082).
					const resolvedRow = after
						? ((yield* run((db) =>
								db
									.select({createdAt: schema.user.createdAt})
									.from(schema.user)
									.where(eq(schema.user.id, after))
									.get(),
							)) ?? null)
						: null;
					const cursor = resolveCursor(after, resolvedRow);
					if (cursor.kind === "miss") return emptyKeysetPage;
					const cursorRow = cursor.kind === "hit" ? cursor.row : null;

					const cursorPredicate = keysetAfter([
						{column: schema.user.createdAt, dir: "desc", value: cursorRow?.createdAt ?? null},
						{column: schema.user.id, dir: "desc", value: after},
					]);

					const where = cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere;

					const fetched = yield* run((db) =>
						db
							.select({
								id: schema.user.id,
								username: schema.user.username,
								email: schema.user.email,
								tier: schema.user.tier,
								createdAt: schema.user.createdAt,
							})
							.from(schema.user)
							.where(where)
							.orderBy(desc(schema.user.createdAt), desc(schema.user.id))
							.limit(first + 1),
					);

					return forwardPage(
						fetched,
						first,
						(r: AdminUserRow) => r.id,
						(row): AdminUserRow => ({
							id: row.id,
							username: row.username,
							email: row.email,
							tier: row.tier,
							createdAt: row.createdAt,
						}),
					);
				}),

				banStatesForAdmin: Effect.fn("Pasaport.banStatesForAdmin")(function* (
					ids: ReadonlyArray<string>,
				) {
					if (ids.length === 0) return new Map<string, BanState>();
					const rows = yield* run((db) =>
						db
							.select({
								id: schema.userBanEvent.id,
								userId: schema.userBanEvent.userId,
								action: schema.userBanEvent.action,
								reason: schema.userBanEvent.reason,
								expiresAt: schema.userBanEvent.expiresAt,
								createdAt: schema.userBanEvent.createdAt,
							})
							.from(schema.userBanEvent)
							.where(inArray(schema.userBanEvent.userId, [...ids])),
					);
					const events: ReadonlyArray<UserBanEvent> = rows.map((row) => ({
						id: row.id,
						userId: row.userId,
						action: row.action,
						reason: row.reason,
						expiresAt: row.expiresAt,
						createdAt: row.createdAt ?? new Date(0),
					}));
					return selectBanStates(events, new Date());
				}),
			};
		}),
	);

/**
 * The atomic teardown of one account — see ADR 0097 §2 for the why. Two things the
 * code will not tell you: content is RE-ATTRIBUTED, not removed (`removed_at`
 * untouched), so votes/scores/karma ride along; and the `user` row is KEPT as a
 * scrubbed tombstone so the `author_id → silinen` redirect and the FKs stay coherent.
 *
 * Every statement must be a query-builder statement (no raw correlated subquery), or
 * D1's `batch()` executor rejects the array.
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
	const dropApikeys = db.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));

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
 * The topics the sweep below is about to un-hide content on, captured BEFORE the batch:
 * afterwards `sandboxed_at` is null and a swept row is indistinguishable from one the
 * author already had live. Same pre-batch capture as `anonymizeAccount`'s email (ADR 0097 §2).
 *
 * Sequential, not `Promise.all`: these ride one D1 connection.
 */
async function readSandboxSweep(db: DrizzleDb, userId: string): Promise<SandboxSweep> {
	const sweptWhere = (
		table: typeof schema.definitionRecord | typeof schema.postRecord | typeof schema.commentRecord,
	) =>
		sandboxBacklogWhere(
			{sandboxedAt: table.sandboxedAt, removedAt: table.removedAt, authorId: table.authorId},
			{authorId: userId},
		);

	// The global `posts` connection is ONE topic however many posts are swept, so its
	// whole question is "any?" — `limit(1)` rather than a list this discards.
	const posts = await db
		.select({id: schema.postRecord.id})
		.from(schema.postRecord)
		.where(sweptWhere(schema.postRecord))
		.limit(1);
	const comments = await db
		.select({postId: schema.commentRecord.postId})
		.from(schema.commentRecord)
		.where(sweptWhere(schema.commentRecord));
	const definitions = await db
		.select({termSlug: schema.definitionRecord.termSlug})
		.from(schema.definitionRecord)
		.where(sweptWhere(schema.definitionRecord));

	return {
		feed: posts.length > 0,
		commentThreads: [...new Set(comments.map((row) => row.postId))],
		definitionTerms: [...new Set(definitions.map((row) => row.termSlug))],
	};
}

/**
 * The atomic çaylak→yazar promotion (#1206). The `tier = 'çaylak'` WHERE is the
 * idempotency guard — an already-yazar account matches 0 rows — and `promoted_at`
 * rides that same guarded UPDATE deliberately, so a non-promoting call stamps nothing.
 *
 * Query-builder statements only, per `buildAnonymizeStatements`.
 */
function buildPromotionStatements(db: DrizzleDb, userId: string, now: Date) {
	const promoteTier = db
		.update(schema.user)
		.set({tier: "yazar", promotedAt: now, updatedAt: now})
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

/**
 * The atomic görünen-ad (display-name) write-through (#2154). The upsert INSERTs a
 * fresh row for a user who never bootstrapped a username, and on conflict overwrites
 * ONLY `display_name` + `updated_at`, preserving `username`/`image`.
 *
 * Query-builder statements only — a raw `db.run(sql)` member 500s a real-D1 batch
 * (#863).
 */
function buildSetDisplayNameStatements(
	db: DrizzleDb,
	userId: string,
	displayName: string,
	now: Date,
) {
	const setUserName = db
		.update(schema.user)
		.set({name: displayName, updatedAt: now})
		.where(eq(schema.user.id, userId));

	const upsertProfileName = db
		.insert(schema.userProfile)
		.values({userId, username: null, displayName, image: null, updatedAt: now})
		.onConflictDoUpdate({
			target: schema.userProfile.userId,
			set: {displayName, updatedAt: now},
		});

	return [setUserName, upsertProfileName] as const;
}
