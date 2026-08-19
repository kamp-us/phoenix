/**
 * `Mecmua` — the mecmua long-form write service (epic #2467). Validation + the DB write
 * live here, never in the fate resolver (ADR 0013).
 *
 * Multiple drafts per author are allowed — the deliberate divergence from pano's
 * one-draft-per-author unique index (#2463) — so `saveDraft` always inserts a fresh id.
 * There is no `authorName` column either: the byline is the LIVE identity resolved from
 * `authorId` at read time, never a snapshot.
 */

import {id} from "@usirin/forge";
import {and, eq, inArray} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {
	emptyKeysetPage,
	forwardPage,
	type KeysetPage,
	keysetAfter,
	resolveCursor,
} from "../../db/keyset.ts";
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import type {UserId} from "../../lib/ids.ts";
import {MecmuaPostNotFound, MecmuaTitleRequired} from "./errors.ts";
import {selectMecmuaFeed} from "./feed-selection.ts";
import type {MecmuaPostId} from "./ids.ts";
import {anonymousMecmuaViewer, mecmuaPostVisibleWhere} from "./MecmuaPostVisibility.ts";
import {MECMUA_FEED_ORDERING, MECMUA_MINE_ORDERING} from "./ordering.ts";
import {type MecmuaPostRow, toMecmuaPostRow} from "./post-fields.ts";

// Branded ids so a transposed `{id, authorId}` is a compile error at the call site (#2700).
export interface SaveMecmuaDraftInput {
	authorId: UserId;
	/** Optional on a draft — a half-filled form persists (empty ⇒ stored as ""). */
	title?: string | null;
	body?: string | null;
	slug?: string | null;
}

export interface PublishMecmuaInput {
	id: MecmuaPostId;
	/** The caller — the write is scoped to their OWN draft. */
	authorId: UserId;
}

/** One reader→author subscription edge (#2500). */
export interface MecmuaSubscriptionInput {
	subscriberId: UserId;
	authorId: UserId;
}

export interface MecmuaFeedInput {
	subscriberId: string;
	first?: number;
	after?: string | null;
}

export interface MecmuaOwnPostsInput {
	authorId: string;
	first?: number;
	after?: string | null;
}

export type MecmuaFeedPage = KeysetPage<MecmuaPostRow>;

const FEED_DEFAULT_FIRST = 20;
const FEED_MAX_FIRST = 100;

export class Mecmua extends Context.Service<
	Mecmua,
	{
		readonly saveDraft: (input: SaveMecmuaDraftInput) => Effect.Effect<MecmuaPostRow>;
		readonly publish: (
			input: PublishMecmuaInput,
		) => Effect.Effect<MecmuaPostRow, MecmuaPostNotFound | MecmuaTitleRequired>;

		/** Idempotent — a re-subscribe is a no-op, never a dup row. */
		readonly subscribe: (input: MecmuaSubscriptionInput) => Effect.Effect<void>;

		/** A miss is a no-op. */
		readonly unsubscribe: (input: MecmuaSubscriptionInput) => Effect.Effect<void>;

		readonly listSubscribedAuthorIds: (
			subscriberId: string,
		) => Effect.Effect<ReadonlyArray<string>>;

		readonly isSubscribed: (subscriberId: UserId, authorId: UserId) => Effect.Effect<boolean>;

		/**
		 * The subscribed-author time feed (#2500), newest-first. Drafts never appear; a
		 * reader with no subscriptions gets an empty page.
		 */
		readonly listFeedConnection: (input: MecmuaFeedInput) => Effect.Effect<MecmuaFeedPage>;

		/**
		 * The author's OWN posts (#2544), drafts included — the PRIVATE complement of the
		 * draft-masked public reads. Scoped `where author_id = ?`, so no other author's
		 * drafts are ever exposed.
		 */
		readonly listOwnPostsConnection: (input: MecmuaOwnPostsInput) => Effect.Effect<MecmuaFeedPage>;
	}
>()("mecmua/Mecmua") {}

export const MecmuaLive = Layer.effect(Mecmua)(
	Effect.gen(function* () {
		// `orDieAccess`: see .patterns/effect-errors.md.
		const {run} = orDieAccess(yield* Drizzle);

		const saveDraft = Effect.fn("Mecmua.saveDraft")(function* (input: SaveMecmuaDraftInput) {
			const now = new Date();
			const postId = id("mecmua");
			const row = {
				id: postId,
				slug: input.slug ?? null,
				title: (input.title ?? "").trim(),
				body: input.body ?? "",
				authorId: input.authorId,
				publishedAt: null,
				createdAt: now,
				updatedAt: now,
			} satisfies typeof schema.mecmuaPost.$inferSelect;
			yield* run((db) => db.insert(schema.mecmuaPost).values(row));
			return toMecmuaPostRow(row);
		});

		const publish = Effect.fn("Mecmua.publish")(function* (input: PublishMecmuaInput) {
			// Ownership-scoped: a foreign or absent id is `MecmuaPostNotFound`, so a yazar
			// can't publish another author's draft.
			const existing = yield* run((db) =>
				db.query.mecmuaPost.findFirst({
					where: {id: input.id, authorId: input.authorId},
				}),
			);
			if (!existing) {
				return yield* new MecmuaPostNotFound({message: "Yayımlanacak yazı bulunamadı."});
			}
			if (existing.title.trim().length === 0) {
				return yield* new MecmuaTitleRequired({message: "Yayımlamak için bir başlık gerekli."});
			}
			const now = new Date();
			// Idempotent re-publish: keep the original instant if already published, else stamp now.
			const publishedAt = existing.publishedAt ?? now;
			yield* run((db) =>
				db
					.update(schema.mecmuaPost)
					.set({publishedAt, updatedAt: now})
					.where(
						and(eq(schema.mecmuaPost.id, input.id), eq(schema.mecmuaPost.authorId, input.authorId)),
					),
			);
			return toMecmuaPostRow({...existing, publishedAt, updatedAt: now});
		});

		const subscribe = Effect.fn("Mecmua.subscribe")(function* (input: MecmuaSubscriptionInput) {
			// The (subscriber, author) primary key makes a re-subscribe a no-op.
			yield* run((db) =>
				db
					.insert(schema.mecmuaSubscription)
					.values({
						subscriberId: input.subscriberId,
						authorId: input.authorId,
						createdAt: new Date(),
					})
					.onConflictDoNothing(),
			);
		});

		const unsubscribe = Effect.fn("Mecmua.unsubscribe")(function* (input: MecmuaSubscriptionInput) {
			yield* run((db) =>
				db
					.delete(schema.mecmuaSubscription)
					.where(
						and(
							eq(schema.mecmuaSubscription.subscriberId, input.subscriberId),
							eq(schema.mecmuaSubscription.authorId, input.authorId),
						),
					),
			);
		});

		const listSubscribedAuthorIds = Effect.fn("Mecmua.listSubscribedAuthorIds")(function* (
			subscriberId: string,
		) {
			const rows = yield* run((db) =>
				db
					.select({authorId: schema.mecmuaSubscription.authorId})
					.from(schema.mecmuaSubscription)
					.where(eq(schema.mecmuaSubscription.subscriberId, subscriberId)),
			);
			return rows.map((r) => r.authorId);
		});

		const isSubscribed = Effect.fn("Mecmua.isSubscribed")(function* (
			subscriberId: string,
			authorId: string,
		) {
			const rows = yield* run((db) =>
				db
					.select({authorId: schema.mecmuaSubscription.authorId})
					.from(schema.mecmuaSubscription)
					.where(
						and(
							eq(schema.mecmuaSubscription.subscriberId, subscriberId),
							eq(schema.mecmuaSubscription.authorId, authorId),
						),
					)
					.limit(1),
			);
			return rows.length > 0;
		});

		const listFeedConnection = Effect.fn("Mecmua.listFeedConnection")(function* (
			input: MecmuaFeedInput,
		) {
			const first = Math.max(1, Math.min(input.first ?? FEED_DEFAULT_FIRST, FEED_MAX_FIRST));
			const after = input.after ?? null;

			const authorIds = yield* listSubscribedAuthorIds(input.subscriberId);
			// Short-circuit before any post read, and avoid an empty `IN ()`.
			if (authorIds.length === 0) return emptyKeysetPage satisfies MecmuaFeedPage;

			// The anonymous viewer even for the subscriber: a feed is a reading surface, so
			// drafts are excluded for everyone including their own author.
			const publishedWhere = mecmuaPostVisibleWhere(
				{publishedAt: schema.mecmuaPost.publishedAt, authorId: schema.mecmuaPost.authorId},
				anonymousMecmuaViewer,
			);
			const baseWhere = and(inArray(schema.mecmuaPost.authorId, authorIds), publishedWhere);

			// Gated by the SAME published mask, so a cursor naming a now-draft or absent row
			// misses → empty page.
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({publishedAt: schema.mecmuaPost.publishedAt})
							.from(schema.mecmuaPost)
							.where(and(eq(schema.mecmuaPost.id, after), publishedWhere))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") return emptyKeysetPage satisfies MecmuaFeedPage;
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			// The opaque `id` cursor value is the `after` string — the anchor row carries
			// only `publishedAt`.
			const cursorPredicate = keysetAfter(
				keysetKeys(MECMUA_FEED_ORDERING, (field) =>
					field === "id" ? after : (cursorRow?.publishedAt ?? null),
				),
			);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.mecmuaPost)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(...orderByColumns(MECMUA_FEED_ORDERING))
					.limit(first + 1),
			);

			// The mask + ordering are enforced authoritatively here, not in the query planner;
			// the SQL above only mirrors them as an index-friendly pre-filter.
			const selected = selectMecmuaFeed(fetched.map(toMecmuaPostRow), new Set(authorIds));
			return forwardPage(selected, first, (r) => r.id) satisfies MecmuaFeedPage;
		});

		const listOwnPostsConnection = Effect.fn("Mecmua.listOwnPostsConnection")(function* (
			input: MecmuaOwnPostsInput,
		) {
			const first = Math.max(1, Math.min(input.first ?? FEED_DEFAULT_FIRST, FEED_MAX_FIRST));
			const after = input.after ?? null;

			// No visibility mask deliberately: the author scope is what keeps other authors'
			// rows out, and drafts (null `publishedAt`) must stay in.
			const baseWhere = eq(schema.mecmuaPost.authorId, input.authorId);

			// Gated by the SAME author scope, so a cursor naming a foreign row misses.
			const resolvedRow = after
				? ((yield* run((db) =>
						db
							.select({createdAt: schema.mecmuaPost.createdAt})
							.from(schema.mecmuaPost)
							.where(and(eq(schema.mecmuaPost.id, after), baseWhere))
							.get(),
					)) ?? null)
				: null;
			const cursor = resolveCursor(after, resolvedRow);
			if (cursor.kind === "miss") return emptyKeysetPage satisfies MecmuaFeedPage;
			const cursorRow = cursor.kind === "hit" ? cursor.row : null;

			const cursorPredicate = keysetAfter(
				keysetKeys(MECMUA_MINE_ORDERING, (field) =>
					field === "id" ? after : (cursorRow?.createdAt ?? null),
				),
			);

			const fetched = yield* run((db) =>
				db
					.select()
					.from(schema.mecmuaPost)
					.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
					.orderBy(...orderByColumns(MECMUA_MINE_ORDERING))
					.limit(first + 1),
			);

			return forwardPage(fetched.map(toMecmuaPostRow), first, (r) => r.id) satisfies MecmuaFeedPage;
		});

		return {
			saveDraft,
			publish,
			subscribe,
			unsubscribe,
			listSubscribedAuthorIds,
			isSubscribed,
			listFeedConnection,
			listOwnPostsConnection,
		};
	}),
);
