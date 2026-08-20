/**
 * `Notification` — the bildirim spine's domain service (#1694, epic #1666).
 *
 * Recipient scoping is structural: every read and every write predicate carries
 * `recipient_id` in its WHERE, so "mutate someone else's notification" matches zero
 * rows by construction — the query builders are exported pure so that predicate is
 * `.toSQL()`-inspectable with no engine (ADR 0082).
 */
import {LivePublisher} from "@kampus/fate-effect";
import {and, count, desc, eq, gte, inArray, isNull, sql} from "drizzle-orm";
import {Context, Duration, Effect, Layer} from "effect";
import {Drizzle, type DrizzleDb, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {
	emptyKeysetPage,
	forwardPage,
	type KeysetPage,
	keysetAfter,
	resolveCursor,
} from "../../db/keyset.ts";
import {NOTIFICATION_CHANNEL_TYPE} from "./channel.ts";
import type {NotificationKind} from "./kind.ts";
import {
	emptyResolvedTargetRows,
	foldTargetHrefs,
	type NotificationTargetKind,
	type ResolvedTargetRows,
	type TargetRef,
} from "./target.ts";

export interface NotificationRecordInput {
	recipientId: string;
	kind: NotificationKind;
	targetKind: NotificationTargetKind;
	targetId: string;
	actorId?: string | null;
	count?: number;
}

/** The aggregate-upsert input (#1695): one UNREAD row per `(recipient, kind, target)`. */
export type NotificationAggregateInput = Omit<NotificationRecordInput, "count">;

/**
 * The windowed-digest input (#3641): the coalescing key is the ACTOR, not the target —
 * one page per `(recipient, kind, actor)` per window, however many targets the actor
 * acted on. `actorId` is therefore required and non-null; a system moment with no actor
 * has no key to coalesce on, so it is unrepresentable here.
 */
export type NotificationDigestInput = Omit<NotificationRecordInput, "count" | "actorId"> & {
	actorId: string;
};

export interface NotificationRow {
	id: string;
	recipientId: string;
	/** Wire-tolerant on READ: the D1 column carries no enum (schema note — emitters
	 * add kinds with no migration), so a row's kind stays `string` at the read
	 * boundary; the closed `NotificationKind` union types the WRITE/emit side. */
	kind: string;
	targetKind: NotificationTargetKind;
	targetId: string;
	actorId: string | null;
	count: number;
	/** Null ⇒ unread; the stamp is the read state (no separate boolean). */
	readAt: Date | null;
	createdAt: Date;
}

export const unreadCountQuery = (db: DrizzleDb, recipientId: string) =>
	db
		.select({count: count()})
		.from(schema.notification)
		.where(
			and(eq(schema.notification.recipientId, recipientId), isNull(schema.notification.readAt)),
		);

/** Flip ONE notification read — scoped to `(id, recipient, unread)`, so a foreign
 * or already-read id matches zero rows (the scoping AC's enforcement site). */
export const markReadStatement = (
	db: DrizzleDb,
	recipientId: string,
	notificationId: string,
	now: Date,
) =>
	db
		.update(schema.notification)
		.set({readAt: now})
		.where(
			and(
				eq(schema.notification.id, notificationId),
				eq(schema.notification.recipientId, recipientId),
				isNull(schema.notification.readAt),
			),
		);

/** The aggregate key's WHERE — recipient-scoped AND unread-only, so a read row is
 * history (never mutated) and a foreign recipient matches zero rows. */
const unreadAggregateWhere = (input: NotificationAggregateInput) =>
	and(
		eq(schema.notification.recipientId, input.recipientId),
		eq(schema.notification.kind, input.kind),
		eq(schema.notification.targetKind, input.targetKind),
		eq(schema.notification.targetId, input.targetId),
		isNull(schema.notification.readAt),
	);

export const bumpUnreadAggregateStatement = (
	db: DrizzleDb,
	input: NotificationAggregateInput,
	now: Date,
) =>
	db
		.update(schema.notification)
		.set({count: sql`${schema.notification.count} + 1`, updatedAt: now})
		.where(unreadAggregateWhere(input));

/**
 * Insert a fresh unread row for the aggregate key ONLY if no unread row exists —
 * the `VouchLedger.castVouch` guarded-insert idiom, so bump + insert run in one
 * D1 batch (transaction) and two concurrent emits can't mint two unread rows.
 * Raw-select values bypass the drizzle `{mode: "timestamp"}` codec, so the
 * timestamps are encoded as the epoch SECONDS the column stores.
 */
export const insertUnlessUnreadStatement = (
	db: DrizzleDb,
	input: NotificationAggregateInput & {id: string},
	now: Date,
) => {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const unreadExists = db
		.select({one: sql`1`})
		.from(schema.notification)
		.where(unreadAggregateWhere(input));
	return db
		.insert(schema.notification)
		.select(
			sql`select ${input.id}, ${input.recipientId}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${input.actorId ?? null}, 1, NULL, ${nowSeconds}, ${nowSeconds} where not exists (${unreadExists})`,
		);
};

/**
 * The open-digest key's WHERE (#3641) — recipient-scoped and unread-only like the
 * aggregate, but keyed on `actor_id` and floored at the window start. A page older
 * than the window (or already read) matches nothing, so the next event mints a fresh
 * page instead of bumping a stale one forever.
 */
const openDigestWhere = (input: NotificationDigestInput, since: Date) =>
	and(
		eq(schema.notification.recipientId, input.recipientId),
		eq(schema.notification.kind, input.kind),
		eq(schema.notification.actorId, input.actorId),
		isNull(schema.notification.readAt),
		gte(schema.notification.createdAt, since),
	);

export const bumpOpenDigestStatement = (
	db: DrizzleDb,
	input: NotificationDigestInput,
	since: Date,
	now: Date,
) =>
	db
		.update(schema.notification)
		.set({count: sql`${schema.notification.count} + 1`, updatedAt: now})
		.where(openDigestWhere(input, since));

/**
 * Mint the window's page ONLY if the actor has no open one — the guarded-insert half
 * of {@link insertUnlessUnreadStatement}, keyed on the actor/window instead. The row
 * carries the window's FIRST target, so the page still links a recipient straight to
 * content; the later coalesced events live behind it (their count is the digest).
 */
export const insertUnlessOpenDigestStatement = (
	db: DrizzleDb,
	input: NotificationDigestInput & {id: string},
	since: Date,
	now: Date,
) => {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const digestExists = db
		.select({one: sql`1`})
		.from(schema.notification)
		.where(openDigestWhere(input, since));
	return db
		.insert(schema.notification)
		.select(
			sql`select ${input.id}, ${input.recipientId}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${input.actorId}, 1, NULL, ${nowSeconds}, ${nowSeconds} where not exists (${digestExists})`,
		);
};

export const markAllReadStatement = (db: DrizzleDb, recipientId: string, now: Date) =>
	db
		.update(schema.notification)
		.set({readAt: now})
		.where(
			and(eq(schema.notification.recipientId, recipientId), isNull(schema.notification.readAt)),
		);

export class Notification extends Context.Service<
	Notification,
	{
		/** Record one notification — the emitter siblings' single write surface. */
		readonly record: (
			input: NotificationRecordInput,
		) => Effect.Effect<{id: string}, never, LivePublisher>;

		/**
		 * Bump the recipient's existing UNREAD row for `(kind, target)` or insert a fresh one, so
		 * activity after a mark-read surfaces as NEW unread and N repeat events never mint N rows.
		 * `aggregated: true` ⇔ an existing row was bumped.
		 */
		readonly recordAggregate: (
			input: NotificationAggregateInput,
		) => Effect.Effect<{aggregated: boolean}, never, LivePublisher>;

		/**
		 * Coalesce every event ONE actor causes inside `window` into a single unread page per
		 * recipient. The target is NOT part of the key, so an actor spraying N targets still costs
		 * one row per recipient per window: this is the fan-out BOUND, not a display roll-up.
		 */
		readonly recordDigest: (
			input: NotificationDigestInput,
			window: Duration.Duration,
		) => Effect.Effect<{digested: boolean}, never, LivePublisher>;

		/** Newest-first, forward keyset pagination (ADR 0019; cursor = notification id). */
		readonly listForRecipient: (
			recipientId: string,
			opts?: {first?: number | undefined; after?: string | null | undefined},
		) => Effect.Effect<KeysetPage<NotificationRow>>;

		readonly unreadCount: (recipientId: string) => Effect.Effect<number>;

		/**
		 * `marked: 0` on a foreign, unknown, or already-read id — an idempotent no-op, never an
		 * existence oracle.
		 */
		readonly markRead: (
			recipientId: string,
			notificationId: string,
		) => Effect.Effect<{marked: number}>;

		readonly markAllRead: (recipientId: string) => Effect.Effect<{marked: number}>;

		/** Batch-resolve target refs to client hrefs; `null` = tombstone. */
		readonly resolveTargets: (
			refs: ReadonlyArray<TargetRef>,
		) => Effect.Effect<ReadonlyMap<string, string | null>>;
	}
>()("@kampus/bildirim/Notification") {}

export const NotificationLive = Layer.effect(Notification)(
	Effect.gen(function* () {
		const {run, batch} = orDieAccess(yield* Drizzle);

		// The ONE live seam every emitter inherits (#1700). Rides `LivePublisher`
		// (swallow-with-log, ADR 0039), so a fan-out failure can never fail the write.
		const publishChannel = Effect.fn("Notification.publishChannel")(function* (
			recipientId: string,
		) {
			const live = yield* LivePublisher;
			const rows = yield* run((db) => unreadCountQuery(db, recipientId));
			const unread = Number(rows[0]?.count ?? 0);
			yield* live.update(NOTIFICATION_CHANNEL_TYPE, recipientId, {
				data: {__typename: NOTIFICATION_CHANNEL_TYPE, id: recipientId, unreadCount: unread},
			});
		});

		const listForRecipient = Effect.fn("Notification.listForRecipient")(function* (
			recipientId: string,
			opts: {first?: number | undefined; after?: string | null | undefined} = {},
		) {
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;

			// The cursor is a notification id resolved to its `created_at` for the keyset tuple,
			// recipient-scoped — a foreign cursor is a miss, not a probe into someone else's list.
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({createdAt: schema.notification.createdAt})
							.from(schema.notification)
							.where(
								and(
									eq(schema.notification.id, after),
									eq(schema.notification.recipientId, recipientId),
								),
							)
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") return emptyKeysetPage;
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			const cursorPredicate = keysetAfter([
				{column: schema.notification.createdAt, dir: "desc", value: cursorRow?.createdAt ?? null},
				{column: schema.notification.id, dir: "desc", value: after},
			]);

			const baseWhere = eq(schema.notification.recipientId, recipientId);
			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.notification)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(desc(schema.notification.createdAt), desc(schema.notification.id))
					.limit(first + 1),
			);

			return forwardPage<(typeof fetched)[number], NotificationRow>(
				fetched,
				first,
				(row) => row.id,
				(row) => ({
					id: row.id,
					recipientId: row.recipientId,
					kind: row.kind,
					targetKind: row.targetKind,
					targetId: row.targetId,
					actorId: row.actorId,
					count: row.count,
					readAt: row.readAt,
					createdAt: row.createdAt,
				}),
			);
		});

		const resolveTargets = Effect.fn("Notification.resolveTargets")(function* (
			refs: ReadonlyArray<TargetRef>,
		) {
			if (refs.length === 0) return foldTargetHrefs(refs, emptyResolvedTargetRows);
			const idsOf = (kind: NotificationTargetKind) => [
				...new Set(refs.filter((r) => r.targetKind === kind).map((r) => r.targetId)),
			];
			const postIds = idsOf("post");
			const commentIds = idsOf("comment");
			const definitionIds = idsOf("definition");
			const userIds = idsOf("user");

			const rows: ResolvedTargetRows = {
				post:
					postIds.length === 0
						? []
						: yield* run((db) =>
								db
									.select({id: schema.postRecord.id})
									.from(schema.postRecord)
									.where(
										and(
											inArray(schema.postRecord.id, postIds),
											isNull(schema.postRecord.removedAt),
										),
									),
							),
				comment:
					commentIds.length === 0
						? []
						: yield* run((db) =>
								db
									.select({id: schema.commentRecord.id, postId: schema.commentRecord.postId})
									.from(schema.commentRecord)
									.where(
										and(
											inArray(schema.commentRecord.id, commentIds),
											isNull(schema.commentRecord.removedAt),
										),
									),
							),
				definition:
					definitionIds.length === 0
						? []
						: yield* run((db) =>
								db
									.select({
										id: schema.definitionRecord.id,
										termSlug: schema.definitionRecord.termSlug,
									})
									.from(schema.definitionRecord)
									.where(
										and(
											inArray(schema.definitionRecord.id, definitionIds),
											isNull(schema.definitionRecord.removedAt),
										),
									),
							),
				user:
					userIds.length === 0
						? []
						: yield* run((db) =>
								db
									.select({id: schema.user.id, username: schema.user.username})
									.from(schema.user)
									.where(and(inArray(schema.user.id, userIds), isNull(schema.user.deletedAt))),
							),
			};

			return foldTargetHrefs(refs, rows);
		});

		return {
			listForRecipient,
			resolveTargets,
			record: Effect.fn("Notification.record")(function* (input: NotificationRecordInput) {
				const id = crypto.randomUUID();
				const now = new Date();
				yield* run((db) =>
					db
						.insert(schema.notification)
						.values({
							id,
							recipientId: input.recipientId,
							kind: input.kind,
							targetKind: input.targetKind,
							targetId: input.targetId,
							actorId: input.actorId ?? null,
							count: input.count ?? 1,
							readAt: null,
							createdAt: now,
							updatedAt: now,
						})
						.run(),
				);
				yield* publishChannel(input.recipientId);
				return {id};
			}),
			// Bump-then-guarded-insert in ONE batch (one D1 transaction), so concurrent emits
			// can't mint two unread rows.
			recordAggregate: Effect.fn("Notification.recordAggregate")(function* (
				input: NotificationAggregateInput,
			) {
				const id = crypto.randomUUID();
				const now = new Date();
				const [bumped] = yield* batch(
					(db) =>
						[
							bumpUnreadAggregateStatement(db, input, now),
							insertUnlessUnreadStatement(db, {...input, id}, now),
						] as const,
				);
				yield* publishChannel(input.recipientId);
				return {aggregated: bumped.meta.changes > 0};
			}),
			recordDigest: Effect.fn("Notification.recordDigest")(function* (
				input: NotificationDigestInput,
				window: Duration.Duration,
			) {
				const id = crypto.randomUUID();
				const now = new Date();
				const since = new Date(now.getTime() - Duration.toMillis(window));
				const [bumped] = yield* batch(
					(db) =>
						[
							bumpOpenDigestStatement(db, input, since, now),
							insertUnlessOpenDigestStatement(db, {...input, id}, since, now),
						] as const,
				);
				yield* publishChannel(input.recipientId);
				return {digested: bumped.meta.changes > 0};
			}),
			unreadCount: Effect.fn("Notification.unreadCount")(function* (recipientId: string) {
				const rows = yield* run((db) => unreadCountQuery(db, recipientId));
				return Number(rows[0]?.count ?? 0);
			}),
			markRead: Effect.fn("Notification.markRead")(function* (
				recipientId: string,
				notificationId: string,
			) {
				const result = yield* run((db) =>
					markReadStatement(db, recipientId, notificationId, new Date()).run(),
				);
				return {marked: result.meta.changes};
			}),
			markAllRead: Effect.fn("Notification.markAllRead")(function* (recipientId: string) {
				const result = yield* run((db) => markAllReadStatement(db, recipientId, new Date()).run());
				return {marked: result.meta.changes};
			}),
		};
	}),
);
