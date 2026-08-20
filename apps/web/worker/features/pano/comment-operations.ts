/**
 * Pano's comments plane: threaded comment CRUD, vote/reaction delegation, the moderator
 * soft-delete/restore pair, and the keyset/by-id reads. `makeCommentOperations` is the
 * layer-build factory `PanoLive` spreads into the service object. Validation lives in
 * the service methods, not resolvers (ADR 0013).
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
import {anonymousViewer, type SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import * as Removal from "../lifecycle/removal.ts";
import {
	ownSandboxed,
	resolveSandboxViewer,
	sandboxBacklogWhere,
	sandboxedInPlace,
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

// Rendered for a `Removed` comment; never written by the delete path. The canonical
// body stays in the row for restore + moderator review (ADR 0096 §5).
export const SILINDI_PLACEHOLDER = "[silindi]";

export interface AddCommentInput {
	postId: PostId;
	authorId: UserId;
	authorName: string;
	body: string;
	parentId?: CommentId | null | undefined;
	// The çaylak mod-only sandbox stamp, decided by the resolver from the authorship flag +
	// author tier. `null`/absent ⇒ created live.
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
	// Carried so the resolver can emit the reply notification without re-reading the post.
	postAuthorId: string;
	// `null` for a top-level comment; resolved off the parent row already loaded for the
	// existence check.
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
	// `null` retracts (toggle off). Already decoded against `ReactionEmojiSchema` at the
	// wire boundary, so the service never sees a non-palette string.
	emoji: ReactionEmoji | null;
}

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
	// Defaults to `AuthorDeletion`.
	reason?: Removal.RemovalReason;
}

export interface DeleteCommentResult {
	commentId: string;
	deleted: boolean;
	hasReplies: boolean;
	placeholder: CommentRow | null;
	// On a restore, where the comment landed: null ⇒ `Live` (broadcast `alwaysLive`),
	// non-null ⇒ back in the çaylak sandbox, so the mutation suppresses the live echo.
	// Absent on a delete result.
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

// The one delta rule every add/delete/restore path routes through. A sandboxed çaylak
// comment is never in the public count, so a sandboxed step moves it by 0; the
// `Math.max(0, …)` floor keeps a raced double-remove from driving the count negative.
export const nextCommentCount = (
	current: number,
	sandboxedAt: Date | null,
	direction: "remove" | "restore",
): number => {
	const step = sandboxedAt != null ? 0 : direction === "remove" ? -1 : 1;
	return Math.max(0, current + step);
};

export interface CommentOperationsDeps {
	readonly run: DrizzleAccessOrDie["run"];
	readonly voteSvc: typeof Vote.Service;
	readonly reactionSvc: typeof Reaction.Service;
	readonly removalSeq: Removal.RemovalSequence;
	readonly persistPanoStats: PersistPanoStats;
	readonly readProfileIdentities: ReadProfileIdentities;
}

export const makeCommentOperations = (deps: CommentOperationsDeps) => {
	const {run, voteSvc, reactionSvc, removalSeq, persistPanoStats, readProfileIdentities} = deps;

	// The delta rule itself lives in `nextCommentCount`; this only loads the post, applies it,
	// and persists. `hotScore` is an explicit opt-in: only the author `deleteComment`
	// refreshes it, so the mod + restore arms leave it untouched — deliberate, not drift.
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

	// One `IN (...)` read for the whole batch, never a per-row N+1.
	const commentVoteScalar = {
		field: "myVote",
		read: (viewerId: string | null | undefined, ids: ReadonlyArray<string>) =>
			voteSvc.readMine(viewerId, "comment", ids),
	} as const;

	// `parallelStampWave` runs the three finalize stamps over the SAME rows and merges. The
	// `parallelStamps` flag picks the concurrency: off ⇒ `1` (serial, byte-for-byte today),
	// on ⇒ `"unbounded"`. The reaction stamp's own two D1 reads inherit the same knob.
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
	// `viewer` is a REQUIRED parameter, not an optional with a default: both sandbox
	// signals are viewer-scoped, so every call site must state whose view it is shaping.
	// A viewer-blind call site (the moderator queue, a broadcast payload) passes
	// `anonymousViewer` deliberately and gets `false` for both — the one safe answer for a
	// row that may reach a non-author (#4282). Taking the whole `SandboxViewer` rather
	// than a bare `viewerId` is what lets `sandboxedInPlace` (#6425) be derived here at
	// all: the in-place class cannot be reconstructed from an id.
	const rowToCommentRow = (
		row: typeof schema.commentRecord.$inferSelect,
		viewer: SandboxViewer,
	): CommentRow => {
		const sandboxed = ownSandboxed(row, viewer.viewerId);
		const inPlace = sandboxedInPlace(row, viewer);
		const lifecycle = Removal.fromColumns(row);
		if (Removal.isRemoved(lifecycle)) {
			return {
				...toCommentRow(row),
				sandboxed,
				sandboxedInPlace: inPlace,
				author: "",
				authorId: "",
				body: SILINDI_PLACEHOLDER,
				deletedAt: lifecycle.removedAt,
			};
		}
		return {...toCommentRow(row), sandboxed, sandboxedInPlace: inPlace};
	};

	const listCommentsKeyset = Effect.fn("Pano.listCommentsKeyset")(function* (
		postId: string,
		opts: {
			first?: number | undefined;
			after?: string | null | undefined;
			viewerId?: string | null | undefined;
			sandboxViewer?: SandboxViewer | undefined;
			mutedIds?: ReadonlySet<string> | undefined;
			// Off ⇒ the wave runs at `concurrency: 1`, byte-for-byte today. Resolved from the
			// default-off `phoenix-pano-stamp-wave` flag.
			parallelStamps?: boolean | undefined;
		} = {},
	) {
		const first = Math.max(1, Math.min(opts.first ?? 50, 200));
		const after = opts.after ?? null;
		const viewerId = opts.viewerId ?? null;
		const viewer = resolveSandboxViewer(opts);

		// A removed comment stays in the thread ONLY to preserve reply structure (ADR 0096
		// §5): keep it when it still has a live child, otherwise omit it.
		const visible = sql`(${schema.commentRecord.removedAt} IS NULL OR EXISTS (SELECT 1 FROM ${schema.commentRecord} AS child WHERE child.parent_id = ${schema.commentRecord.id} AND child.removed_at IS NULL))`;
		const sandboxClause = sandboxVisibleWhere(
			{sandboxedAt: schema.commentRecord.sandboxedAt, authorId: schema.commentRecord.authorId},
			viewer,
		);
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

		// The anchor lookup carries `visible`, so an invisible row (a removed leaf with no live
		// child) is no anchor at all — resolving to null → miss → empty page, exactly as the old
		// hard-delete made the cursor row vanish (ADR 0096 §5).
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

		const page = forwardPage(
			fetched,
			first,
			(r: CommentRow) => r.id,
			(row) => rowToCommentRow(row, viewer),
		);
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
		const viewer = resolveSandboxViewer(opts);
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
							viewer,
						),
						mutedAuthorsWhere(schema.commentRecord.authorId, opts.mutedIds),
					),
				),
		);
		return yield* stampComments(
			fetched.map((row) => rowToCommentRow(row, viewer)),
			viewerId,
			opts.parallelStamps ?? false,
		);
	});

	// A çaylak's still-sandboxed, not-removed comments, scoped to one author when promotion
	// flips their backlog. Authority is gated at the resolver; the service read is unconditional.
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
		// The moderator queue is viewer-blind by construction — it reads OTHER people's
		// pending comments, so both sandbox signals are `false` for every row here.
		return fetched.map((row) => rowToCommentRow(row, anonymousViewer));
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

		// A create bumps the public count +1, gated on the sandbox by the shared delta rule.
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
				// Viewer-blind: the placeholder is published to the whole thread topic
				// (`live.comment.update`), so it must never carry an owner-scoped flag.
				placeholder: rowToCommentRow(row, anonymousViewer),
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
		// SOFT remove for every comment (ADR 0096 §1 — no hard delete): the canonical body is
		// KEPT so restore + moderator review have the real text.
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

		// Self-vote guard (#2216, founder-ruled): a cast on one's OWN comment is rejected at
		// the domain. Cast-only — a blocked cast leaves nothing to retract.
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
		// The tier gate and the self-vote guard fire on the cast direction only, so a
		// retraction never raises them — die if one somehow does, keeping this method's
		// channel to `CommentNotFound`.
		return yield* applyCommentVote(input, false).pipe(
			Effect.catchTags({
				"vote/VoterNotEligible": (e) => Effect.die(e),
				"vote/SelfVoteNotAllowed": (e) => Effect.die(e),
			}),
		);
	});

	// The karma-free, ungated twin of `voteOnComment`: no tier arm and no karma path — a
	// çaylak may react (the settled ungated/social-only model).
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

		// A missing row here is a raced removal — surface it as `CommentNotFound`.
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
