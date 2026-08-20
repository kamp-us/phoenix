/**
 * Optimistic `comment.delete`, mirroring the server's two branches: a leaf's edge drops,
 * a comment with replies stays as a `[silindi]` tombstone. See ADR
 * [0125](../../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md)
 * D1 and ADR [0096](../../../../.decisions/0096-uniform-soft-delete-substrate.md).
 */
import {type EntityId, type List, type Snapshot, toEntityId} from "@nkzw/fate";

/** The `[silindi]` tombstone body — mirrors the server placeholder (`comment-operations.ts`). */
export const SILINDI_PLACEHOLDER = "[silindi]";

/** Must stay exactly the server's `live.update` `changed` set for `comment.delete`, so
 *  the reconciling frame overwrites the same paths field-for-field and can't diverge. */
export const TOMBSTONE_CHANGED = ["body", "score", "deletedAt", "updatedAt"] as const;

export function tombstoneFields(now: Date): {
	body: string;
	score: number;
	deletedAt: Date;
	updatedAt: Date;
} {
	return {body: SILINDI_PLACEHOLDER, score: 0, deletedAt: now, updatedAt: now};
}

export type CommentDeleteStrategy = "edge-drop" | "tombstone";

export interface CommentDeleteContext {
	/** Does any LOADED comment name this one as parent (a reply — deleted or not)? */
	readonly hasLoadedReply: boolean;
	/** Is the whole thread loaded (no further pagination to reveal a reply)? */
	readonly threadComplete: boolean;
}

/**
 * Tombstone is the safe superset, so anything short of a client-certain leaf takes it:
 * the server confirms a tombstone (`live.update`) or shrinks it to a drop
 * (`deleteEdge`), but a `live.update` can never re-add an edge dropped in error.
 */
export function decideCommentDelete(ctx: CommentDeleteContext): CommentDeleteStrategy {
	if (ctx.hasLoadedReply) return "tombstone";
	if (!ctx.threadComplete) return "tombstone";
	return "edge-drop";
}

export function removeOptimisticEdge(list: List, entityId: EntityId): List {
	const index = list.ids.indexOf(entityId);
	if (index === -1) return list;
	return {
		...list,
		ids: list.ids.filter((id) => id !== entityId),
		...(list.cursors ? {cursors: list.cursors.filter((_, i) => i !== index)} : {}),
	};
}

export interface CommentDeleteStore {
	read(id: EntityId): Record<string, unknown> | undefined;
	merge(id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>): void;
	snapshot(id: EntityId): Snapshot;
	restore(id: EntityId, snapshot: Snapshot): void;
	getListsForField(ownerId: EntityId, field: string): ReadonlyArray<readonly [string, List]>;
	setList(key: string, state: List): void;
	restoreList(key: string, list?: List): void;
}

export interface CommentDeletePlan {
	readonly strategy: CommentDeleteStrategy;
	readonly commentId: string;
	readonly postId: string;
	readonly now: Date;
}

/**
 * The tombstone branch deliberately leaves the edge in place, so the subtree keeps
 * hanging. Both branches decrement `commentCount` because the server does so
 * unconditionally (`comment-operations.ts`). Returns a LIFO rollback for the call site
 * to run on a rejected mutation.
 */
export function beginOptimisticCommentDelete(
	store: CommentDeleteStore,
	plan: CommentDeletePlan,
): () => void {
	const rollbacks: Array<() => void> = [];
	const commentEntity = toEntityId("Comment", plan.commentId);
	const postEntity = toEntityId("Post", plan.postId);

	if (plan.strategy === "edge-drop") {
		for (const [key, list] of store.getListsForField(postEntity, "comments")) {
			const next = removeOptimisticEdge(list, commentEntity);
			if (next === list) continue;
			store.setList(key, next);
			rollbacks.push(() => store.restoreList(key, list));
		}
	} else {
		const before = store.snapshot(commentEntity);
		store.merge(commentEntity, tombstoneFields(plan.now), TOMBSTONE_CHANGED);
		rollbacks.push(() => store.restore(commentEntity, before));
	}

	const current = store.read(postEntity)?.commentCount;
	if (typeof current === "number") {
		const before = store.snapshot(postEntity);
		store.merge(postEntity, {commentCount: Math.max(0, current - 1)}, ["commentCount"]);
		rollbacks.push(() => store.restore(postEntity, before));
	}

	return () => {
		for (const rollback of rollbacks.reverse()) rollback();
	};
}
