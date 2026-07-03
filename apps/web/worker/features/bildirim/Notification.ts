/**
 * `Notification` — the bildirim spine's domain service (#1694, epic #1666): the
 * one write surface sibling emitters call (`record`) and the recipient-scoped
 * read/mutate surface the fate resolvers consume (`listForRecipient`,
 * `unreadCount`, `markRead`, `markAllRead`, `resolveTargets`).
 *
 * Recipient scoping is structural: every read and every write predicate carries
 * `recipient_id` in its WHERE, so "mutate someone else's notification" matches
 * zero rows by construction — the query builders are exported pure (the
 * `tierPopulationQuery` idiom) so that predicate is `.toSQL()`-inspectable with
 * no engine (ADR 0082 T1/T2). Reads reach D1 only through the `Drizzle` seam and
 * die on infra errors (`orDieAccess`), so public signatures carry no error.
 */
import {and, count, desc, eq, inArray, isNull} from "drizzle-orm";
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
import {
	emptyResolvedTargetRows,
	foldTargetHrefs,
	type NotificationTargetKind,
	type ResolvedTargetRows,
	type TargetRef,
} from "./target.ts";

export interface NotificationRecordInput {
	recipientId: string;
	/** Plain-text discriminant; each emitter sibling owns its kind names. */
	kind: string;
	targetKind: NotificationTargetKind;
	targetId: string;
	/** Who triggered it, or null for system events. */
	actorId?: string | null;
	/** Aggregate slot (#1698); defaults to 1. */
	count?: number;
}

export interface NotificationRow {
	id: string;
	recipientId: string;
	kind: string;
	targetKind: NotificationTargetKind;
	targetId: string;
	actorId: string | null;
	count: number;
	/** Null ⇒ unread; the stamp is the read state (no separate boolean). */
	readAt: Date | null;
	createdAt: Date;
}

/** The unread-count read — recipient-scoped, unread = `read_at IS NULL`. */
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

/** Flip EVERY unread notification of the recipient read. */
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
		/** Record one notification (the emitter siblings' single write surface). */
		readonly record: (input: NotificationRecordInput) => Effect.Effect<{id: string}>;

		/**
		 * The recipient's notifications, newest-first, forward keyset pagination
		 * (ADR 0019; cursor = notification id, keyset `(created_at desc, id desc)`).
		 */
		readonly listForRecipient: (
			recipientId: string,
			opts?: {first?: number | undefined; after?: string | null | undefined},
		) => Effect.Effect<KeysetPage<NotificationRow>>;

		/** How many of the recipient's notifications are unread. */
		readonly unreadCount: (recipientId: string) => Effect.Effect<number>;

		/**
		 * Mark one notification read. `marked: false` on a foreign, unknown, or
		 * already-read id — an idempotent no-op, never an existence oracle.
		 */
		readonly markRead: (
			recipientId: string,
			notificationId: string,
		) => Effect.Effect<{marked: number}>;

		/** Mark every unread notification of the recipient read. */
		readonly markAllRead: (recipientId: string) => Effect.Effect<{marked: number}>;

		/**
		 * Batch-resolve target refs to client hrefs (`null` = tombstone) — one
		 * `IN (...)` read per kind present, folded by `foldTargetHrefs`.
		 */
		readonly resolveTargets: (
			refs: ReadonlyArray<TargetRef>,
		) => Effect.Effect<ReadonlyMap<string, string | null>>;
	}
>()("@kampus/bildirim/Notification") {}

export const NotificationLive = Layer.effect(Notification)(
	Effect.gen(function* () {
		const {run} = orDieAccess(yield* Drizzle);

		const listForRecipient = Effect.fn("Notification.listForRecipient")(function* (
			recipientId: string,
			opts: {first?: number | undefined; after?: string | null | undefined} = {},
		) {
			const first = Math.max(1, Math.min(opts.first ?? 20, 100));
			const after = opts.after ?? null;

			// The DB read is the port; `resolveCursor` is the pure cursor-miss
			// decision (the Bookmark idiom). The cursor is a notification id,
			// resolved to its `created_at` for the keyset tuple — recipient-scoped,
			// so a foreign cursor is a miss, not a probe into someone else's list.
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
				return {id};
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
