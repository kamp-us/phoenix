/**
 * The optimistic `comment.add` core (#1678, epic #1637) — the A1 strategy fixed
 * by the reconciliation decision ADR
 * [0125](../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md).
 *
 * `Post.comments` is a **nested** connection, not a registered root list, so
 * fate's declarative `insert` can't reach it (`.patterns/fate-mutations-client.md`
 * {#optimistic-nested-membership}). A1 instead writes a temp-id node into the
 * nested list state directly (a locally-authored append), lets the mutation HTTP
 * result rewrite temp→server via fate's own `resolveOptimisticEntity`, and leans
 * on fate's canonical-id dedup so the server `Post.comments.appendNode` frame —
 * before or after — collapses into the same edge (no double row). The
 * `useReadbackRefetch` self-heal narrows to the append-loss healer (#714).
 *
 * This module is the load-bearing, hook-free, fate-free half (mirroring
 * `panoSubmitArgs`'s `postSubmitMembership` / `optimisticEdit`): the flag-gated
 * payload builder plus the two pure list ops (append temp id / remove it) and the
 * store-shim that applies them + returns a rollback. The store is typed as a
 * minimal structural interface so the append + rollback are unit-testable with a
 * fake store, apart from the real fate client. fate's apply/reconcile/rollback of
 * the entity itself is exercised at the integration tier.
 */
import {
	type ConnectionMetadata,
	ConnectionTag,
	type EntityId,
	type List,
	toEntityId,
} from "@nkzw/fate";

/** Injectable now-clock so the optimistic temp id + timestamps are deterministic in tests. */
export type Now = () => Date;

const defaultNow: Now = () => new Date();

/** The already-derived comment values the optimistic node mirrors. */
export interface CommentAddOptimisticInput {
	/** The parent comment id for a reply, or `null` for a top-level comment. */
	readonly parentId: string | null;
	/** The submitted comment body. */
	readonly body: string;
	/** The author's display handle (`@author`) — best-available at submit time. */
	readonly author: string;
	/** The author's user id. */
	readonly authorId: string;
}

/**
 * The optimistic `Comment` record — a temp-id node fate reconciles to the server
 * id on the HTTP result. `score: 0` / `myVote: null` mirror the server's initial
 * state for a fresh comment: submitting is NOT a self-upvote, so a non-zero
 * score/vote would bleed a phantom self-upvote onto the reconciled row (the #707
 * hazard the sibling `postSubmitMembership` guards against). `deletedAt: null` —
 * a live comment.
 */
export interface CommentAddOptimistic {
	readonly id: string;
	readonly parentId: string | null;
	readonly body: string;
	readonly author: string;
	readonly authorId: string;
	readonly score: number;
	readonly myVote: null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly deletedAt: null;
}

/** The temp-id prefix fate reconciles to the server id (`.patterns/fate-mutations-client.md`). */
export const TEMP_COMMENT_ID_PREFIX = "optimistic:";

/**
 * The optimistic `comment.add` payload, or `undefined` when the dark-ship flag is
 * off — the pre-flag behavior: no optimistic node, the comment lands only via the
 * server `appendNode` / read-back (exactly as today). `undefined` lets the call
 * site spread it away under `exactOptionalPropertyTypes`.
 */
export function commentAddOptimistic(
	enabled: boolean,
	input: CommentAddOptimisticInput,
	now: Now = defaultNow,
): CommentAddOptimistic | undefined {
	if (!enabled) return undefined;
	const at = now();
	return {
		id: `${TEMP_COMMENT_ID_PREFIX}${at.getTime()}`,
		parentId: input.parentId,
		body: input.body,
		author: input.author,
		authorId: input.authorId,
		score: 0,
		myVote: null,
		createdAt: at,
		updatedAt: at,
		deletedAt: null,
	};
}

/** The store's `EntityId` for an optimistic node (`Comment:optimistic:<ts>`). */
export function tempCommentEntityId(optimistic: CommentAddOptimistic): EntityId {
	return toEntityId("Comment", optimistic.id);
}

/**
 * Append `entityId` to a nested connection's list state as a **visible** edge,
 * idempotently — mirrors fate's `applyListInsert` visible branch (returns the same
 * list untouched when the id is already present, so a re-apply can't double). The
 * server uses `appendNode` with `live: {append: "visible"}`, so an append matches
 * where the reconciled/live edge lands.
 */
export function appendEntityIdVisible(list: List, entityId: EntityId): List {
	if (list.ids.includes(entityId)) return list;
	return {
		...list,
		ids: [...list.ids, entityId],
		cursors: list.cursors ? [...list.cursors, undefined] : list.cursors,
	};
}

/**
 * Remove `entityId` (and its parallel cursor) from a nested list state — the
 * rollback op. Targeted removal (not a wholesale snapshot restore) so a concurrent
 * live frame from another author survives a failed add's rollback. Idempotent:
 * absent id ⇒ same list.
 */
export function removeEntityId(list: List, entityId: EntityId): List {
	const index = list.ids.indexOf(entityId);
	if (index === -1) return list;
	return {
		...list,
		ids: list.ids.filter((id) => id !== entityId),
		cursors: list.cursors ? list.cursors.filter((_, i) => i !== index) : list.cursors,
	};
}

/** The minimal fate store surface the nested append needs — so it's fakeable in a unit test. */
export interface NestedListStore {
	getListState(key: string): List | undefined;
	setList(key: string, state: List): void;
}

/**
 * Read a connection ref's store list key off its `ConnectionTag` metadata, or
 * `null` when the connection carries none (not yet loaded) — degrade to the plain
 * round-trip rather than guess a key.
 */
export function connectionListKey(connection: unknown): string | null {
	if (!connection || typeof connection !== "object") return null;
	const metadata = (connection as Record<PropertyKey, unknown>)[ConnectionTag] as
		| ConnectionMetadata
		| null
		| undefined;
	return metadata && typeof metadata.key === "string" ? metadata.key : null;
}

/**
 * Insert the optimistic temp node into the nested `Post.comments` list and return
 * a **rollback** that removes it. No-op (returns a no-op rollback) when the list
 * isn't resolved yet — the add still runs as a plain round-trip. On the mutation's
 * HTTP result fate's `resolveOptimisticEntity` rewrites the temp id to the server
 * id across this list (dedup by canonical id), so on **success** the caller must
 * NOT roll back; the rollback fires only on a rejected add.
 */
export function beginOptimisticCommentAppend(
	store: NestedListStore,
	listKey: string | null,
	entityId: EntityId,
): () => void {
	if (!listKey) return () => {};
	const before = store.getListState(listKey);
	if (!before) return () => {};
	store.setList(listKey, appendEntityIdVisible(before, entityId));
	return () => {
		const current = store.getListState(listKey);
		if (current) store.setList(listKey, removeEntityId(current, entityId));
	};
}
