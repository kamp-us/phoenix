/**
 * Optimistic `comment.add`, membership half. See ADR 0125 and
 * `.patterns/fate-mutations-client.md`.
 *
 * `Post.comments` is a nested connection, so fate's `optimistic` param handles the temp
 * entity but never adds it to the list. This module owns exactly that gap.
 */
import {ConnectionTag, type EntityId, type List, type Snapshot, toEntityId} from "@nkzw/fate";

export interface OptimisticCommentInput {
	readonly postId: string;
	readonly parentId: string | null;
	readonly body: string;
	readonly author: string;
	readonly authorId: string;
	/**
	 * Must be `sandboxesNewContent(me.tier)` — the SAME rule the server's
	 * `sandboxedAtForAuthor` applies. Required, not optional: a forgotten flag renders a
	 * çaylak's comment as published for the whole optimistic window (#4282).
	 */
	readonly sandboxed: boolean;
	readonly now: Date;
}

/**
 * `score`/`myVote` must mirror the server's initial comment row (score 0, no self-vote —
 * `comment-operations.ts` `addComment`), else the reconciled row flashes a phantom
 * self-upvote (the #707 class).
 */
export function optimisticCommentRecord(input: OptimisticCommentInput) {
	return {
		id: `optimistic:${input.now.getTime()}`,
		parentId: input.parentId,
		body: input.body,
		author: input.author,
		authorId: input.authorId,
		score: 0,
		myVote: null,
		sandboxed: input.sandboxed,
		createdAt: input.now,
		updatedAt: input.now,
		deletedAt: null,
	};
}

/**
 * Tail, not head: comments are chronological and the server `appendNode`s at the end,
 * so the optimistic edge lands where the reconciled server edge will.
 */
export function appendOptimisticEdge(list: List | undefined, entityId: EntityId): List {
	const base: List = list ?? {ids: []};
	if (base.ids.includes(entityId)) return base;
	return {
		...base,
		ids: [...base.ids, entityId],
		...(base.cursors ? {cursors: [...base.cursors, undefined]} : {}),
	};
}

export interface CommentListStore {
	getListState(key: string): List | undefined;
	setList(key: string, state: List): void;
	restoreList(key: string, list?: List): void;
	read(id: EntityId): Record<string, unknown> | undefined;
	merge(id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>): void;
	snapshot(id: EntityId): Snapshot;
	restore(id: EntityId, snapshot: Snapshot): void;
}

/** Throws rather than no-oping: a mis-wired call site is a bug, not a missing key. */
export function connectionKey(connection: unknown): string {
	const metadata =
		connection != null && typeof connection === "object"
			? (connection as {[ConnectionTag]?: {key?: string}})[ConnectionTag]
			: undefined;
	const key = metadata?.key;
	if (!key) {
		throw new Error("optimisticCommentAdd: value carries no fate connection metadata key");
	}
	return key;
}

/**
 * `tempId` MUST be the `toEntityId("Comment", …)`-qualified entity id, never the bare
 * record id — runtime `Post.comments.list.ids` are qualified, so both reconcile paths
 * key off the qualified id (#1714; `.patterns/fate-mutations-client.md`).
 *
 * The returned rollback runs only on reject: fate rolls back the record but not this
 * manually-added nested membership, nor the `commentCount` bump (`comment.add` returns a
 * `Comment`, not the parent `Post`, so nothing else reconciles the aggregate — #2198).
 */
export function beginOptimisticCommentMembership(
	store: CommentListStore,
	connection: unknown,
	postId: string,
	tempId: EntityId,
): () => void {
	const rollbacks: Array<() => void> = [];
	const key = connectionKey(connection);
	const previous = store.getListState(key);
	store.setList(key, appendOptimisticEdge(previous, tempId));
	rollbacks.push(() => store.restoreList(key, previous));

	const postEntity = toEntityId("Post", postId);
	const current = store.read(postEntity)?.commentCount;
	if (typeof current === "number") {
		const before = store.snapshot(postEntity);
		store.merge(postEntity, {commentCount: current + 1}, ["commentCount"]);
		rollbacks.push(() => store.restore(postEntity, before));
	}

	return () => {
		for (const rollback of rollbacks.reverse()) rollback();
	};
}
