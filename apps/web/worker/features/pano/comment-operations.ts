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
import {stampViewerScalars} from "../fate/viewer-scalars.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxVisibleWhere,
} from "../lifecycle/SandboxVisibility.ts";
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
	postId: string;
	authorId: string;
	authorName: string;
	body: string;
	parentId?: string | null | undefined;
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
	commentId: string;
	voterId: string;
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

export interface EditCommentInput {
	commentId: string;
	actorId: string;
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
	commentId: string;
	actorId: string;
	/** Why the comment is removed (ADR 0096). Defaults to `AuthorDeletion`. */
	reason?: Removal.RemovalReason;
}

export interface DeleteCommentResult {
	commentId: string;
	deleted: boolean;
	hasReplies: boolean;
	placeholder: CommentRow | null;
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

/** The shared runtime deps `PanoLive` threads into the comments plane. */
export interface CommentOperationsDeps {
	readonly run: DrizzleAccessOrDie["run"];
	readonly voteSvc: typeof Vote.Service;
	readonly removalSeq: Removal.RemovalSequence;
	readonly persistPanoStats: PersistPanoStats;
}

export const makeCommentOperations = (deps: CommentOperationsDeps) => {
	const {run, voteSvc, removalSeq, persistPanoStats} = deps;

	// `Comment`'s one viewer scalar: `myVote` from the batched `user_vote` presence
	// read (#1126). Every comment read finalizes through `stampViewerScalars` with
	// this spec — one `IN (...)` read for the whole batch, never a per-row N+1.
	const commentVoteScalar = {
		field: "myVote",
		read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
			voteSvc.readMine(viewerId, "comment", ids),
	} as const;

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
		const baseWhere = and(eq(schema.commentRecord.postId, postId), visible, sandboxClause);
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
		const rows = yield* stampViewerScalars(page.rows, viewerId, [commentVoteScalar]);

		return {...page, rows, totalCount} satisfies CommentConnectionPage;
	});

	const getCommentsByIds = Effect.fn("Pano.getCommentsByIds")(function* (
		ids: ReadonlyArray<string>,
		opts: {viewerId?: string | null | undefined; sandboxViewer?: SandboxViewer | undefined} = {},
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
					),
				),
		);
		return yield* stampViewerScalars(fetched.map(rowToCommentRow), viewerId, [commentVoteScalar]);
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

		// A sandboxed çaylak comment (#1205) is pending — it must not bump the
		// post's PUBLIC `comment_count`. Promotion (#1206) recomputes it on flip.
		const newCommentCount = post.commentCount + (input.sandboxedAt != null ? 0 : 1);
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
		// SOFT remove for every comment now (ADR 0096 §1 — no hard delete): wipe
		// votes via `Vote.clearTarget` (karma KEPT), then stamp the `Removed`
		// triad. The canonical body is KEPT (the `[silindi]` tombstone is rendered
		// by `rowToCommentRow`, not written here), so restore + moderator review
		// have the real text. `hasReplies` now only shapes the result placeholder,
		// not the strategy. `commentCount` + stats refresh outside (caches).
		const removed = Removal.toColumns(
			Removal.remove({
				removedAt: now,
				removedBy: input.actorId,
				reason: input.reason ?? new Removal.AuthorDeletion(),
			}),
		);
		yield* Removal.removeEntity(removalSeq, {kind: "comment", id: input.commentId}, removed, now);

		const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
		if (post) {
			const newCommentCount = Math.max(0, post.commentCount - 1);
			const hotScore = computeHotScore(
				post.score,
				(post.createdAt ?? now).getTime(),
				now.getTime(),
			);
			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({
						commentCount: newCommentCount,
						hotScore,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, row.postId)),
			);
		}

		yield* persistPanoStats(now);

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
		const lifecycle = Removal.fromColumns(row);
		if (!Removal.isRemoved(lifecycle)) {
			return {
				commentId: input.commentId,
				deleted: false,
				hasReplies: false,
				placeholder: null,
			} satisfies DeleteCommentResult;
		}

		const now = new Date();
		const live = Removal.toColumns(Removal.restore(lifecycle));
		yield* Removal.restoreEntity(removalSeq, {kind: "comment", id: input.commentId}, live, now);

		const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
		if (post) {
			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({
						commentCount: post.commentCount + 1,
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, row.postId)),
			);
		}

		yield* persistPanoStats(now);

		return {
			commentId: input.commentId,
			deleted: true,
			hasReplies: false,
			placeholder: null,
		} satisfies DeleteCommentResult;
	});

	const moderateRemoveComment = Effect.fn("Pano.moderateRemoveComment")(function* (input: {
		commentId: string;
		resolverId: string;
		reportId: string;
	}) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({where: {id: input.commentId}}),
		);
		if (!row || Removal.isRemoved(Removal.fromColumns(row))) {
			return {removed: false};
		}

		const now = new Date();
		const removed = Removal.toColumns(
			Removal.remove({
				removedAt: now,
				removedBy: input.resolverId,
				reason: new Removal.Moderated({reportId: input.reportId}),
			}),
		);
		yield* Removal.removeEntity(removalSeq, {kind: "comment", id: input.commentId}, removed, now);

		const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
		if (post) {
			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({
						commentCount: Math.max(0, post.commentCount - 1),
						updatedAt: now,
						lastActivityAt: now,
					})
					.where(eq(schema.postRecord.id, row.postId)),
			);
		}
		yield* persistPanoStats(now);

		return {removed: true};
	});

	const moderateRestoreComment = Effect.fn("Pano.moderateRestoreComment")(function* (input: {
		commentId: string;
	}) {
		const row = yield* run((db) =>
			db.query.commentRecord.findFirst({where: {id: input.commentId}}),
		);
		if (!row) return {restored: false};
		const lifecycle = Removal.fromColumns(row);
		if (!Removal.isRemoved(lifecycle)) return {restored: false};

		const now = new Date();
		const live = Removal.toColumns(Removal.restore(lifecycle));
		yield* Removal.restoreEntity(removalSeq, {kind: "comment", id: input.commentId}, live, now);

		const post = yield* run((db) => db.query.postRecord.findFirst({where: {id: row.postId}}));
		if (post) {
			yield* run((db) =>
				db
					.update(schema.postRecord)
					.set({commentCount: post.commentCount + 1, updatedAt: now, lastActivityAt: now})
					.where(eq(schema.postRecord.id, row.postId)),
			);
		}
		yield* persistPanoStats(now);

		return {restored: true};
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
		return yield* applyCommentVote(input, false);
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
	};
};
