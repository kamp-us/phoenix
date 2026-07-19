/**
 * Optimistic `comment.delete` — the reply-aware nested-connection half (ADR
 * [0125](../../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md)
 * D1, #1680, epic #1637). `comment.delete` returns the parent `Post`, not the
 * comment (so fate's `delete: true` can't be used); the server drives the row live
 * as one of two branches (ADR 0096): a **leaf** publishes `deleteEdge` (the row
 * drops), a comment **with replies** stays as a `[silindi]` tombstone via
 * `live.update` (the edge must NOT leave the connection or the subtree orphans).
 *
 * An optimistic hard-remove is WRONG for the tombstone case, so this mirrors the
 * server branch from the *loaded client tree* — leaf ⇒ edge-drop, has-replies OR an
 * uncertain (incompletely-loaded) tree ⇒ tombstone — with a conservative-tombstone
 * fallback that makes divergence unrepresentable: the only hazard is a stale tree
 * (client thinks leaf, someone else added an unloaded reply) removing a row the
 * server tombstones, and a `live.update` can't re-add a removed edge. Tombstone-on-
 * uncertain removes it — a tombstone is never *wrong*; for a true leaf it lingers a
 * beat until the server `deleteEdge` removes it.
 *
 * No-divergence (the ADR's core): every write is keyed by canonical entity id and is
 * a conservative superset of the authoritative outcome — the server either confirms
 * the tombstone (`live.update`, an idempotent field write over the same `changed`
 * set) or shrinks it (`deleteEdge`), never contradicts. Rollback rides fate's
 * snapshot/restore on reject.
 */
import {type EntityId, type List, type Snapshot, toEntityId} from "@nkzw/fate";

/** The `[silindi]` tombstone body — mirrors the server placeholder (`comment-operations.ts`). */
export const SILINDI_PLACEHOLDER = "[silindi]";

/**
 * The fields the optimistic tombstone writes — exactly the server's `live.update`
 * `changed` set (`comment.delete` publishes `["body", "score", "deletedAt",
 * "updatedAt"]`), so the reconciling frame overwrites the same paths field-for-field
 * and can't diverge. `CommentTreeNode` renders `[silindi]` off `deletedAt != null`.
 */
export const TOMBSTONE_CHANGED = ["body", "score", "deletedAt", "updatedAt"] as const;

/** The optimistic tombstone partial for a removed comment at `now`. */
export function tombstoneFields(now: Date): {
	body: string;
	score: number;
	deletedAt: Date;
	updatedAt: Date;
} {
	return {body: SILINDI_PLACEHOLDER, score: 0, deletedAt: now, updatedAt: now};
}

/** Which server branch the optimistic write mirrors, decided from the loaded tree. */
export type CommentDeleteStrategy = "edge-drop" | "tombstone";

/** The loaded-tree facts the strategy is decided from (both derivable client-side). */
export interface CommentDeleteContext {
	/** Does any LOADED comment name this one as parent (a reply — deleted or not)? */
	readonly hasLoadedReply: boolean;
	/** Is the whole comment thread loaded (no further pagination to reveal a reply)? */
	readonly threadComplete: boolean;
}

/**
 * Mirror the server's reply-aware branch from the loaded tree (ADR 0125 D1). Only a
 * client-certain leaf — no loaded reply AND the thread fully loaded — drops its edge;
 * a known reply parent OR an incompletely-loaded thread (the subtree could hide an
 * unloaded reply) tombstones. Tombstone is the safe superset: the server confirms it
 * (`live.update`) or shrinks it to a drop (`deleteEdge`), never the reverse.
 */
export function decideCommentDelete(ctx: CommentDeleteContext): CommentDeleteStrategy {
	if (ctx.hasLoadedReply) return "tombstone";
	if (!ctx.threadComplete) return "tombstone";
	return "edge-drop";
}

/**
 * Remove a qualified entity id from a nested connection's visible list, keeping
 * `cursors` aligned. Pure + idempotent: an absent id returns the list unchanged, so
 * a re-run never double-drops and reconciliation with the server `deleteEdge` (which
 * removes the same canonical id) collapses to one removal.
 */
export function removeOptimisticEdge(list: List, entityId: EntityId): List {
	const index = list.ids.indexOf(entityId);
	if (index === -1) return list;
	return {
		...list,
		ids: list.ids.filter((id) => id !== entityId),
		...(list.cursors ? {cursors: list.cursors.filter((_, i) => i !== index)} : {}),
	};
}

/** The slice of the fate client `store` the optimistic delete drives. */
export interface CommentDeleteStore {
	read(id: EntityId): Record<string, unknown> | undefined;
	merge(id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>): void;
	snapshot(id: EntityId): Snapshot;
	restore(id: EntityId, snapshot: Snapshot): void;
	getListsForField(ownerId: EntityId, field: string): ReadonlyArray<readonly [string, List]>;
	setList(key: string, state: List): void;
	restoreList(key: string, list?: List): void;
}

/** The resolved delete to apply — its strategy plus the ids the writes key on. */
export interface CommentDeletePlan {
	readonly strategy: CommentDeleteStrategy;
	readonly commentId: string;
	readonly postId: string;
	/** Clock for the tombstone `deletedAt`/`updatedAt` (injectable for deterministic tests). */
	readonly now: Date;
}

/**
 * Apply the optimistic delete and return a rollback that restores every write it
 * made (LIFO), for the call site to run on a rejected mutation. `edge-drop` removes
 * the comment's edge from every backing `Post.comments` list (mirroring fate's SSE
 * `deleteConnectionEdge`); `tombstone` merges the `[silindi]` fields onto the comment
 * record, leaving the edge in place so the subtree keeps hanging. Both branches
 * decrement the parent post's `commentCount` by one — the server does so
 * unconditionally (`comment-operations.ts`), and the authoritative `live.post.update`
 * frame reconciles the field either way.
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
