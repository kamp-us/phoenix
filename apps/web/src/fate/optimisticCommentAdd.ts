/**
 * Optimistic `comment.add` — the nested-connection membership half (ADR 0125, A1).
 *
 * `Post.comments` is a *nested* connection, not a registered root list, so fate's
 * declarative `insert` can't reach it (`.patterns/fate-mutations-client.md`); a new
 * comment joins the thread only via the server `live.comment.thread.appendNode`
 * frame. fate's `optimistic` param still handles the temp *entity* end-to-end —
 * `wrapMutation` writes the temp record, rewrites the temp id to the server id via
 * `resolveOptimisticEntity` on the HTTP result, deletes the temp record, and rolls
 * the record write back on reject — but it never adds the temp id to the nested
 * list. This module owns exactly that gap: append the temp id into the
 * `Post.comments` list state (so the thread shows the comment instantly) and roll
 * that append back on reject.
 *
 * No-divergence (the ADR's core): fate's auto `resolveOptimisticEntity(tempId,
 * serverId)` rewrites the temp id in this list to the server id on the HTTP result
 * (`store.replaceListEntityId`, which also dedups), and the later live
 * `appendNode(serverId)` collapses by canonical id (`live: {append: "visible"}`
 * short-circuits an already-visible id) — so temp-node and server-append are one
 * edge. The only window is a sub-second transient double if the live append lands
 * before the HTTP result resolves temp→server; it collapses the instant it does.
 *
 * çaylak no-leak (AC 4): the optimistic write lives only in the *author's own* fate
 * store — it never crosses the wire, so a sandboxed comment cannot leak to
 * non-authors. Non-author membership comes solely from the server `appendNode`,
 * which stays gated by `decidePublish(sandboxedAt)` (unchanged).
 *
 * Gated behind the default-off `pano-optimistic-comment-add` flag (#1678, epic
 * #1637; ADR 0083) at the call site: off ⇒ no optimistic node, the thread waits for
 * the live append / read-back exactly as today.
 */
import {ConnectionTag, type EntityId, type List, type Snapshot, toEntityId} from "@nkzw/fate";

/** The source values the optimistic temp Comment node mirrors from the compose form + author. */
export interface OptimisticCommentInput {
	/** The parent post id (`comment.add` input `postId`). */
	readonly postId: string;
	/** The replied-to comment id in a reply composer, else `null` (top-level). */
	readonly parentId: string | null;
	/** The trimmed comment body. */
	readonly body: string;
	/** Author display name (`user.name ?? user.email`) — rendered as `@author`. */
	readonly author: string;
	/** The author's user id — drives the edit/delete affordance gate on the node. */
	readonly authorId: string;
	/** The submit instant — seeds the temp id and `createdAt`/`updatedAt`. */
	readonly now: Date;
}

/**
 * Build the optimistic Comment partial passed as fate's `optimistic` payload. The
 * temp `id` is what fate reconciles to the server id (`resolveOptimisticEntity`) when
 * the HTTP result arrives. `score`/`myVote` mirror the server's initial comment row
 * (score 0, no self-vote — `comment-operations.ts` `addComment`), else the reconciled
 * row flashes a phantom self-upvote (the #707 class); `deletedAt: null` renders the
 * node live (not a `[silindi]` tombstone).
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
		createdAt: input.now,
		updatedAt: input.now,
		deletedAt: null,
	};
}

/**
 * Append `entityId` to the tail of a nested connection's visible list — comments are
 * chronological and the server `appendNode`s at the end, so the optimistic edge lands
 * where the reconciled server edge will. Pure + idempotent: an id already present
 * returns the list unchanged, so a re-run never doubles. Keeps `cursors` aligned with
 * `ids` when the list tracks them (the temp edge carries no cursor).
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

/**
 * The slice of the fate client `store` the membership append + rollback drive — the
 * nested-list methods plus the record `read`/`merge`/`snapshot`/`restore` the
 * `Post.commentCount` aggregate bump uses. `fate.store` satisfies it structurally.
 */
export interface CommentListStore {
	getListState(key: string): List | undefined;
	setList(key: string, state: List): void;
	restoreList(key: string, list?: List): void;
	read(id: EntityId): Record<string, unknown> | undefined;
	merge(id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>): void;
	snapshot(id: EntityId): Snapshot;
	restore(id: EntityId, snapshot: Snapshot): void;
}

/**
 * Resolve a nested connection's list key from its fate metadata tag (the same
 * `ConnectionTag` `react-fate`'s `useListView` reads). Throws loudly if the value
 * isn't a fate connection — a mis-wired call site is a bug, not a silent no-op.
 */
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
 * Insert `tempId` into the nested comment connection and return a rollback that
 * restores the prior list state. `tempId` MUST be the `toEntityId("Comment", …)`-
 * qualified entity id (`Comment:optimistic:<ts>`), never the bare record id — runtime
 * `Post.comments.list.ids` are qualified, so both reconcile paths key off the
 * qualified id (#1714; `.patterns/fate-mutations-client.md`). fate's auto
 * `resolveOptimisticEntity` rewrites `tempId` to the server id on success (no manual
 * reconcile here); the returned rollback runs only on reject (callSite `{error}` OR a
 * boundary throw), since fate rolls back the record but not this manually-added
 * nested membership.
 *
 * Also bumps the parent post's `commentCount` aggregate by one so the post header
 * (`PanoPostHeader`) and feed card (`PanoPostCard`) agree with the rendered thread
 * during the optimistic window — `comment.add` returns a `Comment`, not the parent
 * `Post`, so nothing else reconciles the aggregate until a refetch (#2198); the
 * mirror of `comment.delete`'s decrement (`optimisticCommentDelete`). The bump rolls
 * back with the list edge.
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
