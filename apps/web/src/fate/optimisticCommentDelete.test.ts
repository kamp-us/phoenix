import {type List, type Snapshot, toEntityId} from "@nkzw/fate";
import {describe, expect, it} from "vitest";
import {
	beginOptimisticCommentDelete,
	type CommentDeleteStore,
	decideCommentDelete,
	removeOptimisticEdge,
	SILINDI_PLACEHOLDER,
	TOMBSTONE_CHANGED,
	tombstoneFields,
} from "./optimisticCommentDelete";

/**
 * Covers the load-bearing optimistic `comment.delete` core (ADR 0125 D1, #1680): the
 * reply-aware strategy decision (leaf-drop vs conservative tombstone), the pure
 * edge-removal, the tombstone field partial, and the store-driving apply + rollback
 * (edge-drop, tombstone, and the shared commentCount decrement). Inspected off the
 * REAL exported functions the call site routes through; fate's own snapshot/restore +
 * live-frame reconcile are exercised at the integration/e2e tier.
 */
const fixedNow = new Date("2026-07-02T12:00:00.000Z");

describe("decideCommentDelete — reply-aware branch from the loaded tree", () => {
	it("known leaf with a fully-loaded thread ⇒ edge-drop", () => {
		expect(decideCommentDelete({hasLoadedReply: false, threadComplete: true})).toBe("edge-drop");
	});

	it("a loaded reply parent ⇒ tombstone (edge must stay or the subtree orphans)", () => {
		expect(decideCommentDelete({hasLoadedReply: true, threadComplete: true})).toBe("tombstone");
	});

	it("no loaded reply but an incomplete thread ⇒ conservative tombstone (uncertain)", () => {
		expect(decideCommentDelete({hasLoadedReply: false, threadComplete: false})).toBe("tombstone");
	});

	it("a loaded reply on an incomplete thread ⇒ tombstone", () => {
		expect(decideCommentDelete({hasLoadedReply: true, threadComplete: false})).toBe("tombstone");
	});
});

describe("tombstoneFields — mirrors the server live.update changed set", () => {
	it("sets the [silindi] body, wiped score, and deletedAt/updatedAt at now", () => {
		expect(tombstoneFields(fixedNow)).toEqual({
			body: SILINDI_PLACEHOLDER,
			score: 0,
			deletedAt: fixedNow,
			updatedAt: fixedNow,
		});
	});

	it("the written paths equal the server's published changed set", () => {
		expect([...TOMBSTONE_CHANGED]).toEqual(["body", "score", "deletedAt", "updatedAt"]);
	});
});

describe("removeOptimisticEdge — pure nested-connection edge drop", () => {
	it("removes the id, keeping the rest in order", () => {
		expect(removeOptimisticEdge({ids: ["a", "b", "c"]}, "b").ids).toEqual(["a", "c"]);
	});

	it("is idempotent — an absent id returns the list unchanged (no double-drop)", () => {
		const list: List = {ids: ["a", "c"]};
		expect(removeOptimisticEdge(list, "b")).toBe(list);
	});

	it("keeps cursors aligned with the removed slot", () => {
		const next = removeOptimisticEdge({ids: ["a", "b", "c"], cursors: ["ca", "cb", "cc"]}, "b");
		expect(next.ids).toEqual(["a", "c"]);
		expect(next.cursors).toEqual(["ca", "cc"]);
	});

	it("leaves cursors absent when the source list tracks none", () => {
		expect(removeOptimisticEdge({ids: ["a", "b"]}, "b").cursors).toBeUndefined();
	});
});

const POST_ID = "post_1";
const POST_ENTITY = toEntityId("Post", POST_ID);
const COMMENT_ID = "comm_1";
const COMMENT_ENTITY = toEntityId("Comment", COMMENT_ID);
const LIST_KEY = "Post:post_1.comments";

/** A minimal in-memory {@link CommentDeleteStore} over records + one comments list. */
function fakeStore(seed: {
	records?: Record<string, Record<string, unknown>>;
	list?: List;
}): CommentDeleteStore & {
	readonly record: (id: string) => Record<string, unknown> | undefined;
	readonly listState: () => List | undefined;
} {
	const records = new Map<string, Record<string, unknown>>(
		Object.entries(seed.records ?? {}).map(([k, v]) => [k, {...v}]),
	);
	const lists = new Map<string, List>();
	if (seed.list) lists.set(LIST_KEY, seed.list);
	return {
		read: (id) => records.get(id),
		merge: (id, partial) => records.set(id, {...(records.get(id) ?? {}), ...partial}),
		// snapshot/restore round-trip the whole record via the real Snapshot shape
		// ({record}), so fate's pre-write state is restored on rollback.
		snapshot: (id): Snapshot => ({record: {...records.get(id)}}),
		restore: (id, snap) => records.set(id, {...(snap.record ?? {})}),
		getListsForField: (ownerId, field) =>
			ownerId === POST_ENTITY && field === "comments" && lists.has(LIST_KEY)
				? [[LIST_KEY, lists.get(LIST_KEY)!] as const]
				: [],
		setList: (key, state) => void lists.set(key, state),
		restoreList: (key, list) => void (list ? lists.set(key, list) : lists.delete(key)),
		record: (id) => records.get(id),
		listState: () => lists.get(LIST_KEY),
	};
}

describe("beginOptimisticCommentDelete — edge-drop branch", () => {
	it("drops the comment edge and decrements commentCount immediately", () => {
		const store = fakeStore({
			records: {[POST_ENTITY]: {commentCount: 3}},
			list: {ids: [toEntityId("Comment", "comm_0"), COMMENT_ENTITY]},
		});
		beginOptimisticCommentDelete(store, {
			strategy: "edge-drop",
			commentId: COMMENT_ID,
			postId: POST_ID,
			now: fixedNow,
		});
		expect(store.listState()?.ids).toEqual([toEntityId("Comment", "comm_0")]);
		expect(store.record(POST_ENTITY)?.commentCount).toBe(2);
	});

	it("rollback restores the edge and commentCount (no phantom drop)", () => {
		const store = fakeStore({
			records: {[POST_ENTITY]: {commentCount: 3}},
			list: {ids: [toEntityId("Comment", "comm_0"), COMMENT_ENTITY]},
		});
		const rollback = beginOptimisticCommentDelete(store, {
			strategy: "edge-drop",
			commentId: COMMENT_ID,
			postId: POST_ID,
			now: fixedNow,
		});
		rollback();
		expect(store.listState()?.ids).toEqual([toEntityId("Comment", "comm_0"), COMMENT_ENTITY]);
		expect(store.record(POST_ENTITY)?.commentCount).toBe(3);
	});
});

describe("beginOptimisticCommentDelete — tombstone branch", () => {
	it("keeps the edge and merges the [silindi] fields onto the comment record", () => {
		const store = fakeStore({
			records: {
				[POST_ENTITY]: {commentCount: 3},
				[COMMENT_ENTITY]: {body: "asıl yorum", score: 5, deletedAt: null},
			},
			list: {ids: [COMMENT_ENTITY]},
		});
		beginOptimisticCommentDelete(store, {
			strategy: "tombstone",
			commentId: COMMENT_ID,
			postId: POST_ID,
			now: fixedNow,
		});
		// edge stays (the subtree must not orphan)
		expect(store.listState()?.ids).toEqual([COMMENT_ENTITY]);
		expect(store.record(COMMENT_ENTITY)).toMatchObject({
			body: SILINDI_PLACEHOLDER,
			score: 0,
			deletedAt: fixedNow,
			updatedAt: fixedNow,
		});
		expect(store.record(POST_ENTITY)?.commentCount).toBe(2);
	});

	it("rollback restores the original comment body/score and commentCount", () => {
		const store = fakeStore({
			records: {
				[POST_ENTITY]: {commentCount: 3},
				[COMMENT_ENTITY]: {body: "asıl yorum", score: 5, deletedAt: null},
			},
			list: {ids: [COMMENT_ENTITY]},
		});
		const rollback = beginOptimisticCommentDelete(store, {
			strategy: "tombstone",
			commentId: COMMENT_ID,
			postId: POST_ID,
			now: fixedNow,
		});
		rollback();
		expect(store.record(COMMENT_ENTITY)).toEqual({body: "asıl yorum", score: 5, deletedAt: null});
		expect(store.record(POST_ENTITY)?.commentCount).toBe(3);
	});
});

describe("beginOptimisticCommentDelete — commentCount guards", () => {
	it("never drives commentCount below zero", () => {
		const store = fakeStore({
			records: {[POST_ENTITY]: {commentCount: 0}},
			list: {ids: [COMMENT_ENTITY]},
		});
		beginOptimisticCommentDelete(store, {
			strategy: "edge-drop",
			commentId: COMMENT_ID,
			postId: POST_ID,
			now: fixedNow,
		});
		expect(store.record(POST_ENTITY)?.commentCount).toBe(0);
	});

	it("leaves commentCount untouched when the post record is not loaded", () => {
		const store = fakeStore({list: {ids: [COMMENT_ENTITY]}});
		const rollback = beginOptimisticCommentDelete(store, {
			strategy: "edge-drop",
			commentId: COMMENT_ID,
			postId: POST_ID,
			now: fixedNow,
		});
		expect(store.record(POST_ENTITY)).toBeUndefined();
		rollback(); // must not throw
		expect(store.listState()?.ids).toEqual([COMMENT_ENTITY]);
	});
});
