/**
 * Pano's **comments plane** — the comment half of the `Pano` service: the threaded
 * comment CRUD, vote delegation, the moderator soft-delete/restore pair, and the
 * keyset/by-id reads (with the `[silindi]` tombstone projection). `makeCommentOperations`
 * is the layer-build factory: `PanoLive` hands it the shared runtime deps and spreads
 * the returned closures into the service object, so the wire surface is unchanged from
 * when these lived inline in `Pano.ts`.
 *
 * Validation lives in the service methods, not resolvers (ADR 0013); `validateCommentBody`
 * is the module-private pure gate, tested off-DB THROUGH `addComment`/`editComment`
 * (`submit-validation.unit.test.ts`).
 */
import {id} from "@usirin/forge";
import {and, desc, eq, inArray, isNull, sql} from "drizzle-orm";
import {Effect} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {computeHotScore} from "../../db/hotScore.ts";
import {emptyKeysetPage, forwardPage, keysetAfter, resolveCursor} from "../../db/keyset.ts";
import {keysetKeys, orderByColumns} from "../../db/ordering.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {UserId} from "../../lib/ids.ts";
import {type ReadProfileIdentities, stampAuthorIdentity} from "../fate/author-identity.ts";
import {stampReactionAggregate} from "../fate/reaction-aggregate.ts";
import {parallelStampWave} from "../fate/stamp-wave.ts";
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import {applyRemovalTransition} from "../lifecycle/apply-removal-transition.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
import {mutedAuthorsWhere} from "../mute/read-mask.ts";
import type {ReactionTargetNotFound} from "../reaction/errors.ts";
import type {Reaction} from "../reaction/Reaction.ts";
import type {ReportId} from "../report/ids.ts";
import {SelfVoteNotAllowed} from "../vote/errors.ts";
import {translateVoteMiss} from "../vote/translate-vote-miss.ts";
import type {Vote} from "../vote/Vote.ts";
import {type CommentConnectionPage, type CommentRow, toCommentRow} from "./comment-fields.ts";
import {
	CommentBodyRequired,
	CommentBodyTooLong,
	CommentNotFound,
	ParentCommentNotFound,
	PostNotFound,
	UnauthorizedCommentMutation,
} from "./errors.ts";
import {excerpt} from "./excerpt.ts";
import type {CommentId, PostId} from "./ids.ts";
import {COMMENT_ORDERING} from "./ordering.ts";
import type {PersistPanoStats} from "./pano-stats.ts";

export const COMMENT_BODY_MAX = 5_000;

/**
 * Tombstone body the view layer renders for a `Removed` comment (ADR 0096 §5) —
 * not a body the delete path writes. The canonical body stays in the row for
 * restore + moderator review; `rowToCommentRow` substitutes this for display.
 */
export const SILINDI_PLACEHOLDER = "[silindi]";

export interface AddCommentInput {
	postId: PostId;
	authorId: UserId;
	authorName: string;
	body: string;
	parentId?: CommentId | null | undefined;
	/**
	 * The çaylak mod-only sandbox stamp (#1205), decided by the resolver from the
	 * authorship flag + author tier. `null`/absent ⇒ created live (today's behavior).
	 */
	sandboxedAt?: Date | null | undefined;
}

export interface AddCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	/**
	 * The post author — the recipient of a "someone replied to your post" moment
	 * (#1697). Carried on the result so the resolver can emit the conversation
	 * notification without re-reading the post.
	 */
	postAuthorId: string;
	/**
	 * The parent-comment author for a threaded reply, or `null` for a top-level
	 * comment — the recipient of a "someone replied to your comment" moment
	 * (#1697), resolved off the parent row already loaded for the existence check.
	 */
	parentAuthorId: string | null;
}

export interface VoteOnCommentInput {
	commentId: CommentId;
	voterId: UserId;
}

export interface VoteOnCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	myVote: boolean;
	changed: boolean;
}

export interface ReactToCommentInput {
	commentId: CommentId;
	userId: UserId;
	/**
	 * The reaction intent: a curated-palette member sets/changes the user's single
	 * reaction; `null` retracts it (toggle off). Already decoded against
	 * `ReactionEmojiSchema` at the wire boundary, so the service never sees a
	 * non-palette string.
	 */
	emoji: ReactionEmoji | null;
}

/**
 * `reactToComment` re-resolves the affected comment like a read (the `getCommentsByIds`
 * idiom), so the returned row carries the freshly-stamped `reactions` aggregate the
 * mutation echoes back. `changed` is the service's idempotency signal (a re-react of
 * the same emoji, or a retract-when-none, is `false`).
 */
export interface ReactToCommentResult {
	comment: CommentRow;
	changed: boolean;
}

export interface EditCommentInput {
	commentId: CommentId;
	actorId: UserId;
	body: string;
}

export interface EditCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeleteCommentInput {
	commentId: CommentId;
	actorId: UserId;
	/** Why the comment is removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Removal.RemovalReason;
}

export interface DeleteCommentResult {
	commentId: string;
	deleted: boolean;
	hasReplies: boolean;
	placeholder: CommentRow | null;
	/**
	 * On a restore, the `sandboxedAt` the comment landed back at (#1811): `null` ⇒
	 * restored to `Live` (broadcast `alwaysLive`); non-null ⇒ restored to the çaylak
	 * sandbox, so the mutation suppresses the live echo via `decidePublish`. Absent on
	 * a delete result.
	 */
	sandboxedAt?: Date | null;
}

const validateCommentBody = Effect.fn("Pano.validateCommentBody")(function* (
	body: string | null | undefined,
) {
	const rawBody = body ?? "";
	if (rawBody.trim().length === 0) {
		return yield* new CommentBodyRequired({
			message: "yorum boş olamaz",
		});
	}
	if (rawBody.length > COMMENT_BODY_MAX) {
		return yield* new CommentBodyTooLong({
			message: `yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
		});
	}
	return rawBody;
});

/**
 * The single source of truth for a post's public `comment_count` after one
 * comment lifecycle step — the delta rule every add / delete / restore /
 * mod-remove / mod-restore path routes through, so the count is derived here
 * once and never re-hand-written per method. A sandboxed çaylak comment (#1205)
 * is never in the public count, so a sandboxed step moves it by 0 — the
 * create-gate the delete path must mirror (#1831/#1811). The `Math.max(0, …)`
 * floor keeps a raced double-remove from driving the public count negative
 * (the #1831 class this rule makes unrepresentable). A create bumps the count
 * the same +1 as a `restore`.
 */
export const nextCommentCount = (
	current: number,
	sandboxedAt: Date | null,
	direction: "remove" | "restore",
): number => {
	const step = sandboxedAt != null ? 0 : direction === "remove" ? -1 : 1;
	return Math.max(0, current + step);
};

/** The shared runtime deps `PanoLive` threads into the comments plane. */
export interface CommentOperationsDeps {
	readonly run: DrizzleAccessOrDie["run"];
	readonly voteSvc: typeof Vote.Service;
	readonly reactionSvc: typeof Reaction.Service;
	readonly removalSeq: Removal.RemovalSequence;
	readonly persistPanoStats: PersistPanoStats;
	/** Batched live author-identity reader (`Pasaport.getProfileIdentitiesByIds`, #2139). */
	readonly readProfileIdentities: ReadProfileIdentities;
}

export const makeCommentOperations = (deps: CommentOperationsDeps) => {
	const {run, voteSvc, reactionSvc, removalSeq, persistPanoStats, readProfileIdentities} = deps;

	// The parent post's PUBLIC `comment_count` bookkeeping every comment remove/restore
	// shares — the plane-specific `afterCommit` the four transition methods run after the
	// substrate write. The delta rule itself lives in `nextCommentCount`; this only loads
	// the post, applies it, and persists. `hotScore` is an explicit opt-in: only the author
	// `deleteComment` refreshes it (`recomputeHot`), so the mod + restore arms leave it
	// untouched — a deliberate per-caller decision, not an incidental divergence.
	const adjustPostCommentCount = (
		postId: string,
		sandboxedAt: Date | null,
		now: Date,
		direction: "remove" | "restore",
		opts: {recomputeHot?: boolean} = {},
	) =>
		Effect.gen(function* () {
			const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: postId}}));
			if (!post) return;
			const commentCount = nextCommentCount(post.commentCount, sandboxedAt, direction);
			const hotScore = opts.recomputeHot
				? computeHotScore(post.score, (post.createdAt ?? now).getTime(), now.getTime())
				: undefined;
			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({
						commentCount,
						...(hotScore !== undefined ? {hotScore} : {}),
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, postId)),
			);
		});

	// `Comment`'s one viewer scalar: `myVote` from the batched `user_vote` presence
	// read (#1126). Every comment read finalizes through `stampViewerScalars` with
	// this spec — one `IN (...)` read for the whole batch, never a per-row N+1.
	const commentVoteScalar = {
		field: "myVote",
		read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
			voteSvc.readMine(viewerId, "comment", ids),
	} as const;

	// The three independent finalize stamps every comment read shares — `myVote` (viewer
	// scalar), the reaction aggregate, live author identity — each independent given the
	// fetched rows. `parallelStampWave` runs them over the SAME rows and merges; the
	// `parallelStamps` flag picks the concurrency: off ⇒ `1` (serial, byte-for-byte today),
	// on ⇒ `"unbounded"` (one wave, the #2710 collapse). The reaction stamp's own two D1
	// reads inherit the same knob so the whole wave is one phase when on. Mirrors sözlük's
	// `stampDefinitions` (#2709), reusing the same combinator behind pano's own seam.
	const stampComments = <R extends {id: string; authorId: string}>(
		rows: ReadonlyArray<R>,
		viewerId: string | null,
		parallelStamps: boolean,
	) => {
		const concurrency = parallelStamps ? "unbounded" : 1;
		return parallelStampWave(
			rows,
			[
				(rs) => stampViewerScalars(rs, viewerId, [commentVoteScalar]),
				(rs) => stampReactionAggregate(reactionSvc, "comment", rs, viewerId, {concurrency}),
				(rs) => stampAuthorIdentity(readProfileIdentities, rs),
			],
			{concurrency},
		);
	};

	// The tombstone is rendered HERE, from the lifecycle projection — not written
	// into the canonical body by the delete path (ADR 0096 §5). A `Removed`
	// comment surfaces as the `[silindi]` placeholder with author elided; its real
	// body stays in the row for restore + moderator review. `deletedAt` on the
	// wire-facing `CommentRow` is the removal timestamp (presentation contract).
	// The live shape comes from the `comment-fields.ts` column→field map; the
	// tombstone overrides the four presentation fields it elides.
	const rowToCommentRow = (row: typeof schema.commentRecord.$inferSelect): CommentRow => {
		const lifecycle = Removal.fromColumns(row);
		if (Removal.isRemoved(lifecycle)) {
			return {
				...toCommentRow(row),
				author: "",
				authorId: "",
				body: SILINDI_PLACEHOLDER,
				deletedAt: lifecycle.removedAt,
			};
		}
		return toCommentRow(row);
	};

	const listCommentsKeyset = Effect.fn("Pano.listCommentsKeyset")(function* (
		postId: string,
		opts: {
			first?: number | undefined;
			after?: string | null | undefined;
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
			mutedIds?: ReadonlySet<string> | undefined;
			/**
			 * Route the finalize stamps through the concurrent {@link parallelStampWave}
			 * instead of the serial chain (#2710). Default/off ⇒ the wave runs at
			 * `concurrency: 1` — byte-for-byte today. The resolver resolves it from the
			 * default-off `phoenix-pano-stamp-wave` flag.
			 */
			parallelStamps?: boolean | undefined;
		} = {},
	) {
		const first = Math.max(1, Math.min(opts.first ?? 50, 200));
		const after = opts.after ?? null;
		const viewerId = opts.viewerId ?? null;

		// A removed comment stays in the thread ONLY to preserve reply structure
		// (ADR 0096 §5): keep it when it still has a live child (rendered as the
		// `[silindi]` tombstone by `rowToCommentRow`), otherwise omit it. A live
		// comment is always shown.
		const visible = sql`(${schema.commentRecord.removedAt} IS NULL OR EXISTS (SELECT 1 FROM ${schema.commentRecord} AS child WHERE child.parent_id = ${schema.commentRecord.id} AND child.removed_at IS NULL))`;
		// A çaylak-sandboxed comment (#1205) is filtered for this viewer beside the
		// removal/reply-structure guard above.
		const sandboxClause = sandboxVisibleWhere(
			{sandboxedAt: schema.commentRecord.sandboxedAt, authorId: schema.commentRecord.authorId},
			resolveSandboxViewer(opts),
		);
		// Mute read-mask (#3113): hide muted authors' comments from the muter's thread.
		const muteClause = mutedAuthorsWhere(schema.commentRecord.authorId, opts.mutedIds);
		const baseWhere = and(
			eq(schema.commentRecord.postId, postId),
			visible,
			sandboxClause,
			muteClause,
		);
		const totalCount = yield* run((db) =>
			db
				.select({n: sql<number>`count(*)`})
				.from(schema.commentRecord)
				.where(baseWhere)
				.get()
				.then((r) => r?.n ?? 0),
		);

		// Resolve the (created_at) cursor tuple. The DB read is the port;
		// `resolveCursor` is the pure cursor-miss decision (see `listPostsConnection`).
		// The anchor lookup carries `visible`, so an invisible row (a removed leaf with
		// no live child) is no anchor at all — resolving to null → miss → empty page,
		// exactly as the old hard-delete made the cursor row vanish (ADR 0096 §5).
		const resolvedRow = after
			? ((yield* run((db) =>
					db
						.select({createdAt: schema.commentRecord.createdAt})
						.from(schema.commentRecord)
						.where(and(eq(schema.commentRecord.id, after), visible))
						.get(),
				)) ?? null)
			: null;
		const cursor = resolveCursor(after, resolvedRow);
		if (cursor.kind === "miss") {
			return {...emptyKeysetPage, totalCount} satisfies CommentConnectionPage;
		}
		const cursorRow = cursor.kind === "hit" ? cursor.row : null;

		// The predicate and `orderBy` derive from `COMMENT_ORDERING`; the `id`
		// cursor value is the opaque `after` (the resolved row carries only
		// `createdAt`).
		const cursorPredicate = keysetAfter(
			keysetKeys(COMMENT_ORDERING, (field) =>
				field === "id" ? after : (cursorRow?.createdAt ?? null),
			),
		);

		const fetched = yield* run((db) =>
			db
				.select()
				.from(schema.commentRecord)
				.where(cursorPredicate ? and(baseWhere, cursorPredicate) : baseWhere)
				.orderBy(...orderByColumns(COMMENT_ORDERING))
				.limit(first + 1),
		);

		const page = forwardPage(fetched, first, (r: CommentRow) => r.id, rowToCommentRow);
		const rows = yield* stampComments(page.rows, viewerId, opts.parallelStamps ?? false);

		return {...page, rows, totalCount} satisfies CommentConnectionPage;
	});

	const getCommentsByIds = Effect.fn("Pano.getCommentsByIds")(function* (
		ids: ReadonlyArray<string>,
		opts: {
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
			mutedIds?: ReadonlySet<string> | undefined;
			/** See `listCommentsKeyset`'s `parallelStamps` (#2710). */
			parallelStamps?: boolean | undefined;
		} = {},
	) {
		if (ids.length === 0) return [];
		const viewerId = opts.viewerId ?? null;
		const fetched = yield* run((db) =>
			db
				.select()
				.from(schema.commentRecord)
				.where(
					and(
						inArray(schema.commentRecord.id, [...ids]),
						sandboxVisibleWhere(
							{
								sandboxedAt: schema.commentRecord.sandboxedAt,
								authorId: schema.commentRecord.authorId,
							},
							resolveSandboxViewer(opts),
						),
						// Mute read-mask (#3113): drop muted authors' comments from the batch.
						mutedAuthorsWhere(schema.commentRecord.authorId, opts.mutedIds),
					),
				),
		);
		return yield* stampComments(
			fetched.map(rowToCommentRow),
			viewerId,
			opts.parallelStamps ?? false,
		);
	});

	// The moderator sandbox-queue / promotion-backlog read model (#1205, the #1206
	// seam): a çaylak's still-sandboxed, not-removed comments — scoped to one author
	// when promotion flips their backlog. Authority is gated at the resolver; the
	// service read is unconditional.
	const listSandboxedComments = Effect.fn("Pano.listSandboxedComments")(function* (
		opts: {authorId?: string | undefined} = {},
	) {
		const fetched = yield* run((db) =>
			db
				.select()
				.from(schema.commentRecord)
				.where(
					sandboxBacklogWhere(
						{
							sandboxedAt: schema.commentRecord.sandboxedAt,
							removedAt: schema.commentRecord.removedAt,
							authorId: schema.commentRecord.authorId,
						},
						{authorId: opts.authorId},
					),
				)
				.orderBy(desc(schema.commentRecord.createdAt)),
		);
		return fetched.map(rowToCommentRow);
	});

	const lookupCommentPostId = Effect.fn("Pano.lookupCommentPostId")(function* (commentId: string) {
		const rows = yield* run((db) =>
			db
				.select({postId: schema.commentRecord.postId})
				.from(schema.commentRecord)
				.where(eq(schema.commentRecord.id, commentId))
				.limit(1),
		);
		return rows[0]?.postId ?? null;
	});

	const addComment = Effect.fn("Pano.addComment")(function* (input: AddCommentInput) {
		const rawBody = yield* validateCommentBody(input.body);

		const post = yield* run((db) =>
			db.query.postRecord.findFirst({
				where: {id: input.postId, removedAt: {isNull: true}},
			}),
		);
		if (!post) {
			return yield* new PostNotFound({
				postId: input.postId,
				message: `post ${input.postId} not found`,
			});
		}

		const parentId = input.parentId ?? null;
		let parentAuthorId: string | null = null;
		if (parentId !== null) {
			const parent = yield* run((db) =>
				db.query.commentRecord.findFirst({
					where: {id: parentId, postId: input.postId, removedAt: {isNull: true}},
				}),
			);
			if (!parent) {
				return yield* new ParentCommentNotFound({
					message: "yanıtlanan yorum bulunamadı",
				});
			}
			parentAuthorId = parent.authorId;
		}

		const now = new Date();
		const commentId = id("comm");
		const bodyExcerpt = excerpt(rawBody);

		yield* run((db) =>
			db.insert(schema.commentRecord).values({
				id: commentId,
				authorId: input.authorId,
				authorName: input.authorName,
				postId: input.postId,
				postTitle: post.title,
				parentId,
				body: rawBody,
				bodyExcerpt,
				score: 0,
				createdAt: now,
				updatedAt: now,
				removedAt: null,
				sandboxedAt: input.sandboxedAt ?? null,
			}),
		);

		// A create bumps the public count the same +1 as a `restore`, gated on the
		// sandbox by the shared delta rule (a sandboxed çaylak comment (#1205) stays
		// pending and is recomputed into the count on promotion, #1206).
		const newCommentCount = nextCommentCount(
			post.commentCount,
			input.sandboxedAt ?? null,
			"restore",
		);
		const hotScore = computeHotScore(post.score, (post.createdAt ?? now).getTime(), now.getTime());

		yield* run((db) =>
			db
				.update(schema.postRecord)
				.set({
					commentCount: newCommentCount,
					hotScore,
					updatedAt: now,
					lastActivityAt: now,
				})
				.where(eq(schema.postRecord.id, input.postId)),
		);

		yield* persistPanoStats(now);

		return {
			commentId,
			postId: input.postId,
			parentId,
			authorId: input.authorId,
			authorName: input.authorName,
			body: rawBody,
			score: 0,
			commentCount: newCommentCount,
			createdAt: now,
			postAuthorId: post.authorId,
			parentAuthorId,
		} satisfies AddCommentResult;
	});

	const editComment = Effect.fn("Pano.editComment")(function* (input: EditCommentInput) {
		const rawBody = yield* validateCommentBody(input.body);

		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({
				where: {id: input.commentId, removedAt: {isNull: true}},
			}),
		);
		if (!row) {
			return yield* new CommentNotFound({
				commentId: input.commentId,
				message: `comment ${input.commentId} not found`,
			});
		}
		if (row.authorId !== input.actorId) {
			return yield* new UnauthorizedCommentMutation({
				commentId: input.commentId,
				message: `not authorized to mutate comment ${input.commentId}`,
			});
		}

		const now = new Date();
		const bodyExcerpt = excerpt(rawBody);

		yield* run((db) =>
			db
				.update(schema.commentRecord)
				.set({body: rawBody, bodyExcerpt, updatedAt: now})
				.where(eq(schema.commentRecord.id, input.commentId)),
		);

		return {
			commentId: input.commentId,
			postId: row.postId,
			parentId: row.parentId,
			authorId: row.authorId,
			authorName: row.authorName,
			body: rawBody,
			score: row.score,
			createdAt: row.createdAt ?? now,
			updatedAt: now,
		} satisfies EditCommentResult;
	});

	const deleteComment = Effect.fn("Pano.deleteComment")(function* (input: DeleteCommentInput) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({where: {id: input.commentId}}),
		);
		if (!row) {
			return yield* new CommentNotFound({
				commentId: input.commentId,
				message: `comment ${input.commentId} not found`,
			});
		}
		if (row.authorId !== input.actorId) {
			return yield* new UnauthorizedCommentMutation({
				commentId: input.commentId,
				message: `not authorized to mutate comment ${input.commentId}`,
			});
		}
		if (Removal.isRemoved(Removal.fromColumns(row))) {
			return {
				commentId: input.commentId,
				deleted: false,
				hasReplies: true,
				placeholder: rowToCommentRow(row),
			} satisfies DeleteCommentResult;
		}

		const childCountRow = yield* run((db) =>
			db
				.select({n: sql<number>`COUNT(*)`})
				.from(schema.commentRecord)
				.where(
					and(
						eq(schema.commentRecord.parentId, input.commentId),
						isNull(schema.commentRecord.removedAt),
					),
				)
				.get(),
		);
		const hasReplies = (childCountRow?.n ?? 0) > 0;

		const now = new Date();
		// SOFT remove for every comment now (ADR 0096 §1 — no hard delete). The canonical
		// body is KEPT (the `[silindi]` tombstone is rendered by `rowToCommentRow`, not
		// written here), so restore + moderator review have the real text. `hasReplies`
		// only shapes the result placeholder, not the strategy.
		yield* applyRemovalTransition({
			label: "Pano.deleteComment",
			transition: "remove",
			seq: removalSeq,
			subject: row,
			target: {kind: "comment", id: input.commentId},
			removedBy: input.actorId,
			reason: input.reason ?? new Removal.AuthorDeletion(),
			now,
			afterCommit: (sandboxedAt) =>
				adjustPostCommentCount(row.postId, sandboxedAt, now, "remove", {recomputeHot: true}),
			refresh: persistPanoStats(now),
		});

		const placeholder: CommentRow | null = hasReplies
			? {
					id: input.commentId,
					parentId: row.parentId,
					author: "",
					authorId: "",
					body: SILINDI_PLACEHOLDER,
					score: 0,
					createdAt: row.createdAt ?? new Date(0),
					updatedAt: now,
					deletedAt: now,
				}
			: null;

		return {
			commentId: input.commentId,
			deleted: true,
			hasReplies,
			placeholder,
		} satisfies DeleteCommentResult;
	});

	const restoreComment = Effect.fn("Pano.restoreComment")(function* (input: DeleteCommentInput) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({where: {id: input.commentId}}),
		);
		if (!row) {
			return yield* new CommentNotFound({
				commentId: input.commentId,
				message: `comment ${input.commentId} not found`,
			});
		}
		if (row.authorId !== input.actorId) {
			return yield* new UnauthorizedCommentMutation({
				commentId: input.commentId,
				message: `not authorized to mutate comment ${input.commentId}`,
			});
		}
		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.restoreComment",
			transition: "restore",
			seq: removalSeq,
			subject: row,
			target: {kind: "comment", id: input.commentId},
			now,
			afterCommit: (sandboxedAt) => adjustPostCommentCount(row.postId, sandboxedAt, now, "restore"),
			refresh: persistPanoStats(now),
		});
		if (!outcome.committed) {
			return {
				commentId: input.commentId,
				deleted: false,
				hasReplies: false,
				placeholder: null,
			} satisfies DeleteCommentResult;
		}

		return {
			commentId: input.commentId,
			deleted: true,
			hasReplies: false,
			placeholder: null,
			sandboxedAt: outcome.sandboxedAt,
		} satisfies DeleteCommentResult;
	});

	const moderateRemoveComment = Effect.fn("Pano.moderateRemoveComment")(function* (input: {
		commentId: string;
		resolverId: string;
		reportId: ReportId;
	}) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({where: {id: input.commentId}}),
		);
		if (!row) return {removed: false};

		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.moderateRemoveComment",
			transition: "remove",
			seq: removalSeq,
			subject: row,
			target: {kind: "comment", id: input.commentId},
			removedBy: input.resolverId,
			reason: new Removal.Moderated({reportId: input.reportId}),
			now,
			afterCommit: (sandboxedAt) => adjustPostCommentCount(row.postId, sandboxedAt, now, "remove"),
			refresh: persistPanoStats(now),
		});

		return {removed: outcome.committed};
	});

	const moderateRestoreComment = Effect.fn("Pano.moderateRestoreComment")(function* (input: {
		commentId: string;
	}) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({where: {id: input.commentId}}),
		);
		if (!row) return {restored: false, sandboxedAt: null};

		const now = new Date();
		const outcome = yield* applyRemovalTransition({
			label: "Pano.moderateRestoreComment",
			transition: "restore",
			seq: removalSeq,
			subject: row,
			target: {kind: "comment", id: input.commentId},
			now,
			afterCommit: (sandboxedAt) => adjustPostCommentCount(row.postId, sandboxedAt, now, "restore"),
			refresh: persistPanoStats(now),
		});
		if (!outcome.committed) return {restored: false, sandboxedAt: null};

		// `outcome.sandboxedAt` is the round-tripped marker (#1811) — report's live re-append
		// gates the thread broadcast on it (a sandboxed restore stays suppressed).
		return {restored: true, sandboxedAt: outcome.sandboxedAt};
	});

	/**
	 * Shared body for `voteOnComment` / `retractCommentVote`. Delegates to
	 * `Vote.cast`. Translates `VoteTargetNotFound` from Vote into
	 * `CommentNotFound`.
	 */
	const applyCommentVote = Effect.fn("Pano.applyCommentVote")(function* (
		input: VoteOnCommentInput,
		isVote: boolean,
	) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({
				where: {id: input.commentId, removedAt: {isNull: true}},
			}),
		);
		if (!row) {
			return yield* new CommentNotFound({
				commentId: input.commentId,
				message: `comment ${input.commentId} not found`,
			});
		}

		// Self-vote guard (#2216, founder-ruled) — the comment twin of `applyPostVote`'s
		// guard: a cast on one's OWN comment is rejected at the domain, so an inflated
		// self-score is unrepresentable rather than caught downstream. Cast-only (a
		// retraction is exempt because a blocked cast leaves nothing to retract).
		if (isVote && row.authorId === input.voterId) {
			return yield* new SelfVoteNotAllowed({
				voterId: input.voterId,
				message: "kendi yorumuna oy veremezsin",
			});
		}

		const voteResult = yield* voteSvc
			.cast({
				userId: input.voterId,
				targetKind: "comment",
				targetId: input.commentId,
				value: isVote,
			})
			.pipe(
				translateVoteMiss(
					() =>
						new CommentNotFound({
							commentId: input.commentId,
							message: `comment ${input.commentId} not found`,
						}),
				),
			);

		const now = new Date();
		return {
			commentId: input.commentId,
			postId: row.postId,
			parentId: row.parentId,
			authorId: row.authorId,
			authorName: row.authorName,
			body: row.body,
			score: voteResult.score,
			createdAt: row.createdAt ?? now,
			myVote: voteResult.myVote,
			changed: voteResult.changed,
		} satisfies VoteOnCommentResult;
	});

	const voteOnComment = Effect.fn("Pano.voteOnComment")(function* (input: VoteOnCommentInput) {
		return yield* applyCommentVote(input, true);
	});

	const retractCommentVote = Effect.fn("Pano.retractCommentVote")(function* (
		input: VoteOnCommentInput,
	) {
		// See `retractPostVote`: the tier gate and the self-vote guard both fire on the cast
		// direction only, so a retraction never raises `VoterNotEligible` /
		// `SelfVoteNotAllowed` — die if one somehow does, keeping this method's channel to
		// `CommentNotFound`.
		return yield* applyCommentVote(input, false).pipe(
			Effect.catchTags({
				"vote/VoterNotEligible": (e) => Effect.die(e),
				"vote/SelfVoteNotAllowed": (e) => Effect.die(e),
			}),
		);
	});

	// Reaction delegation — the karma-free, ungated twin of `voteOnComment` (#1864),
	// the direct mirror of `reactToPost`. Delegates the write to `Reaction.react`
	// (kind `comment`), translates the internal `ReactionTargetNotFound` into the
	// wire-facing `CommentNotFound`, then RE-RESOLVES the comment via the same batched
	// `getCommentsByIds` read the comment views use so the returned row carries the
	// fresh `reactions` aggregate + `myReaction`. Unlike `voteOnComment` there is NO
	// tier arm (`VoterNotEligible`) and NO karma path: a çaylak may react, and nothing
	// writes karma — the settled ungated/social-only model (epic #1840).
	const reactToComment = Effect.fn("Pano.reactToComment")(function* (input: ReactToCommentInput) {
		const result = yield* reactionSvc
			.react({
				userId: input.userId,
				targetKind: "comment",
				targetId: input.commentId,
				emoji: input.emoji,
			})
			.pipe(
				Effect.catchTag(
					"reaction/ReactionTargetNotFound",
					(_: ReactionTargetNotFound) =>
						new CommentNotFound({
							commentId: input.commentId,
							message: `comment ${input.commentId} not found`,
						}),
				),
			);

		// Re-resolve like a read so the echoed row carries the freshly-stamped
		// `reactions` aggregate (counts + the viewer's own `myReaction`). The react
		// write already asserted the target is live, so a missing row here is a raced
		// removal — surface it as `CommentNotFound`, same as the post path.
		const [row] = yield* getCommentsByIds([input.commentId], {viewerId: input.userId});
		if (!row) {
			return yield* new CommentNotFound({
				commentId: input.commentId,
				message: `comment ${input.commentId} not found`,
			});
		}
		return {comment: row, changed: result.changed} satisfies ReactToCommentResult;
	});

	return {
		listCommentsKeyset,
		getCommentsByIds,
		listSandboxedComments,
		lookupCommentPostId,
		addComment,
		editComment,
		deleteComment,
		restoreComment,
		moderateRemoveComment,
		moderateRestoreComment,
		voteOnComment,
		retractCommentVote,
		reactToComment,
	};
};
