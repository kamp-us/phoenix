/**
 * `Mecmua` — the mecmua long-form write service (#2497, epic #2467, #2463). The
 * domain-object home for the two write acts, reached only through the `Drizzle` seam
 * and dying on infra errors via `orDieAccess` (the `Report`/`Pano` service idiom):
 * validation + the DB write live here, never in the fate resolver (ADR 0013).
 *
 * Two acts:
 *   - {@link MecmuaService.saveDraft} — insert a NEW draft row (`publishedAt = null`).
 *     Multiple drafts per author are allowed (the deliberate divergence from pano's
 *     one-draft-per-author partial-unique index, #2463), so this always inserts a
 *     fresh id — never a probe-then-upsert.
 *   - {@link MecmuaService.publish} — stamp `publishedAt` on the caller's own draft
 *     (the yazar-floored act, gated at the mutation by `PublishMecmua`). The write is
 *     scoped `where id = ? AND author_id = ?`, so a yazar can only publish their OWN
 *     draft; a miss is {@link MecmuaPostNotFound}.
 *
 * There is no `authorName` column — the byline is the LIVE identity resolved from
 * `authorId` at read time (#2463), so a publish stamps only `publishedAt`; the byline
 * follows the author's current identity, never a snapshot.
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

// The write-path input ids carry their brands (MecmuaPostId / UserId) so a
// transposed `{id, authorId}` is a compile error at the resolver call site — the
// brands are type-only, so the DB where/values still see plain strings (#2700).
export interface SaveMecmuaDraftInput {
	authorId: UserId;
	/** Optional on a draft — a half-filled form persists (empty ⇒ stored as ""). */
	title?: string | null;
	body?: string | null;
	slug?: string | null;
}

export interface PublishMecmuaInput {
	/** The draft to publish. */
	id: MecmuaPostId;
	/** The caller — the write is scoped to their OWN draft. */
	authorId: UserId;
}

/** One reader→author subscription edge (#2500). */
export interface MecmuaSubscriptionInput {
	/** The reader who follows. */
	subscriberId: UserId;
	/** The author followed. */
	authorId: UserId;
}

/** The subscribed-author feed page request — `subscriberId` + forward keyset window. */
export interface MecmuaFeedInput {
	subscriberId: string;
	first?: number;
	after?: string | null;
}

/** The author's own-posts page request (#2544) — `authorId` + forward keyset window. */
export interface MecmuaOwnPostsInput {
	authorId: string;
	first?: number;
	after?: string | null;
}

/** A forward page of the subscribed-author feed — plain `MecmuaPostRow`s, keyset-ordered. */
export type MecmuaFeedPage = KeysetPage<MecmuaPostRow>;

/** The feed page size default + clamp bound (mirrors the pano feed clamp). */
const FEED_DEFAULT_FIRST = 20;
const FEED_MAX_FIRST = 100;

export class Mecmua extends Context.Service<
	Mecmua,
	{
		readonly saveDraft: (input: SaveMecmuaDraftInput) => Effect.Effect<MecmuaPostRow>;
		readonly publish: (
			input: PublishMecmuaInput,
		) => Effect.Effect<MecmuaPostRow, MecmuaPostNotFound | MecmuaTitleRequired>;

		/** Follow an author (#2500). Idempotent — a re-subscribe is a no-op, never a dup row. */
		readonly subscribe: (input: MecmuaSubscriptionInput) => Effect.Effect<void>;

		/** Unfollow an author (#2500). A miss is a no-op. */
		readonly unsubscribe: (input: MecmuaSubscriptionInput) => Effect.Effect<void>;

		/** The author ids a reader is subscribed to — the feed's author-selection edge read. */
		readonly listSubscribedAuthorIds: (
			subscriberId: string,
		) => Effect.Effect<ReadonlyArray<string>>;

		/** Whether `subscriberId` follows `authorId` — the subscribe-affordance state read (#2527). */
		readonly isSubscribed: (subscriberId: UserId, authorId: UserId) => Effect.Effect<boolean>;

		/**
		 * The subscribed-author time feed (#2500): a forward keyset page of PUBLISHED
		 * mecmua posts from the reader's subscribed authors, ordered `publishedAt desc, id
		 * desc` (newest-first). Drafts never appear (the `MecmuaPostVisibility` published
		 * mask); a reader with no subscriptions gets an empty page.
		 */
		readonly listFeedConnection: (input: MecmuaFeedInput) => Effect.Effect<MecmuaFeedPage>;

		/**
		 * The author's OWN posts (#2544): a forward keyset page of the caller's posts —
		 * BOTH drafts (`publishedAt is null`) and published — ordered `createdAt desc, id
		 * desc` (newest-started first). This is the PRIVATE complement of the draft-masked
		 * public reads: it is scoped `where author_id = ?`, so only the caller's own rows
		 * ever resolve and no other author's drafts are exposed.
		 */
		readonly listOwnPostsConnection: (input: MecmuaOwnPostsInput) => Effect.Effect<MecmuaFeedPage>;
	}
>()("mecmua/Mecmua") {}

export const MecmuaLive = Layer.effect(Mecmua)(
	Effect.gen(function* () {
		// `orDieAccess`: every internal DB call dies on `DrizzleError` (infra failures are
		// defects, `.patterns/effect-errors.md`), so method signatures carry domain errors only.
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
			// Ownership-scoped read: only the caller's OWN row resolves, so a yazar can't
			// publish another author's draft (a foreign/absent id is MECMUA_POST_NOT_FOUND).
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
			// Idempotent: the (subscriber, author) primary key makes a re-subscribe a no-op
			// rather than a duplicate-key failure — one follow edge, at most.
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
			// No subscriptions ⇒ no feed. Short-circuit before any post read (and avoid an
			// empty `IN ()`), returning the shared empty page.
			if (authorIds.length === 0) return emptyKeysetPage satisfies MecmuaFeedPage;

			// The published mask (drafts excluded for everyone, author included) reused from
			// `MecmuaPostVisibility` against the anonymous viewer — a feed is a reading surface.
			const publishedWhere = mecmuaPostVisibleWhere(
				{publishedAt: schema.mecmuaPost.publishedAt, authorId: schema.mecmuaPost.authorId},
				anonymousMecmuaViewer,
			);
			const baseWhere = and(inArray(schema.mecmuaPost.authorId, authorIds), publishedWhere);

			// Resolve the `after` cursor to its `publishedAt` anchor, gated by the SAME
			// published mask so a cursor naming a now-draft/absent row misses → empty page.
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

			// Predicate + `orderBy` both derive from `MECMUA_FEED_ORDERING`; the opaque `id`
			// cursor value is the `after` string (the anchor row carries only `publishedAt`).
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

			// The published-mask + ordering are enforced authoritatively in JS here (the SQL
			// above mirrors them for an index-friendly pre-filter), so the feed's two ACs hold
			// on the served path, not only in the query planner — see `feed-selection.ts`.
			const selected = selectMecmuaFeed(fetched.map(toMecmuaPostRow), new Set(authorIds));
			return forwardPage(selected, first, (r) => r.id) satisfies MecmuaFeedPage;
		});

		const listOwnPostsConnection = Effect.fn("Mecmua.listOwnPostsConnection")(function* (
			input: MecmuaOwnPostsInput,
		) {
			const first = Math.max(1, Math.min(input.first ?? FEED_DEFAULT_FIRST, FEED_MAX_FIRST));
			const after = input.after ?? null;

			// Own posts only — `author_id = ?` includes drafts (null `publishedAt`), so no
			// visibility mask is applied: the author always sees their own rows, and the
			// scoping guarantees another author's rows never resolve (rides the
			// `mecmua_post_author_created` index).
			const baseWhere = eq(schema.mecmuaPost.authorId, input.authorId);

			// Resolve the `after` cursor to its `createdAt` anchor, gated by the SAME author
			// scope so a cursor naming a foreign/absent row misses → empty page.
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
