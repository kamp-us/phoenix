import {ConnectionTag, type EntityId, type List, type Snapshot} from "@nkzw/fate";
import {describe, expect, it} from "vitest";
import {
	appendOptimisticEdge,
	beginOptimisticCommentMembership,
	type CommentListStore,
	connectionKey,
	optimisticCommentRecord,
} from "./optimisticCommentAdd";

/**
 * Covers the load-bearing optimistic `comment.add` membership core (ADR 0125, A1,
 * #1678): the temp-node payload shape (server-mirrored initial row), the pure
 * append-into-nested-connection edge (idempotent, so a re-run never doubles vs the
 * later live `appendNode`), and the store-driving membership helper's append +
 * rollback. Inspected off the REAL exported functions the call site routes through.
 * fate's own reconcile (`resolveOptimisticEntity` temp→server dedup) + record
 * rollback are exercised at the integration/e2e tier; this pins the client-owned
 * membership half hook-free.
 */
const fixedNow = new Date("2026-07-02T12:00:00.000Z");

describe("optimisticCommentRecord — the temp node payload", () => {
	it("stamps a temp id from the clock and mirrors the server's initial row", () => {
		const record = optimisticCommentRecord({
			postId: "post_1",
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			now: fixedNow,
		});
		expect(record).toEqual({
			id: `optimistic:${fixedNow.getTime()}`,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			// server initial: score 0, no self-vote (else a phantom self-upvote flash, #707)
			score: 0,
			myVote: null,
			createdAt: fixedNow,
			updatedAt: fixedNow,
			// live node, not a [silindi] tombstone
			deletedAt: null,
		});
	});

	it("carries the parentId for a reply (same nested connection as top-level)", () => {
		const record = optimisticCommentRecord({
			postId: "post_1",
			parentId: "comm_parent",
			body: "yanıt",
			author: "umut",
			authorId: "user_1",
			now: fixedNow,
		});
		expect(record.parentId).toBe("comm_parent");
	});
});

describe("appendOptimisticEdge — pure nested-connection append", () => {
	it("appends the id to the tail (chronological, where the server appendNode lands)", () => {
		const list: List = {ids: ["a", "b"]};
		expect(appendOptimisticEdge(list, "temp").ids).toEqual(["a", "b", "temp"]);
	});

	it("seeds an empty list when the connection has no state yet (first comment)", () => {
		expect(appendOptimisticEdge(undefined, "temp").ids).toEqual(["temp"]);
	});

	it("is idempotent — an already-present id returns the list unchanged (no double)", () => {
		const list: List = {ids: ["a", "temp"]};
		const next = appendOptimisticEdge(list, "temp");
		expect(next.ids).toEqual(["a", "temp"]);
		expect(next).toBe(list);
	});

	it("keeps cursors aligned with ids when the list tracks them", () => {
		const list: List = {ids: ["a"], cursors: ["cur_a"]};
		const next = appendOptimisticEdge(list, "temp");
		expect(next.ids).toEqual(["a", "temp"]);
		expect(next.cursors).toEqual(["cur_a", undefined]);
	});

	it("leaves cursors absent when the source list tracks none", () => {
		const next = appendOptimisticEdge({ids: ["a"]}, "temp");
		expect(next.cursors).toBeUndefined();
	});
});

describe("connectionKey — resolves the fate metadata key", () => {
	it("reads the key off the ConnectionTag metadata", () => {
		const connection = {[ConnectionTag]: {key: "Post:post_1.comments"}};
		expect(connectionKey(connection)).toBe("Post:post_1.comments");
	});

	it("throws loudly on a value that is not a fate connection", () => {
		expect(() => connectionKey({})).toThrow(/no fate connection metadata key/);
		expect(() => connectionKey(null)).toThrow(/no fate connection metadata key/);
	});
});

/** A minimal in-memory `CommentListStore` over lists + records for the membership helper. */
function fakeStore(
	initial?: List,
	records?: Record<string, Record<string, unknown>>,
): CommentListStore & {
	readonly current: () => List | undefined;
	readonly record: (id: EntityId) => Record<string, unknown> | undefined;
} {
	const lists = new Map<string, List>();
	if (initial) lists.set(KEY, initial);
	const recs = new Map<string, Record<string, unknown>>(
		Object.entries(records ?? {}).map(([k, v]) => [k, {...v}]),
	);
	return {
		getListState: (key) => lists.get(key),
		setList: (key, state) => void lists.set(key, state),
		// mirror fate: restore(undefined) deletes the list (no prior state)
		restoreList: (key, list) => void (list ? lists.set(key, list) : lists.delete(key)),
		read: (id) => recs.get(id),
		merge: (id, partial) => void recs.set(id, {...(recs.get(id) ?? {}), ...partial}),
		snapshot: (id): Snapshot => ({record: {...recs.get(id)}}),
		restore: (id, snap) => void recs.set(id, {...(snap.record ?? {})}),
		current: () => lists.get(KEY),
		record: (id) => recs.get(id),
	};
}
const KEY = "Post:post_1.comments";
const POST_ID = "post_1";
const POST_ENTITY = "Post:post_1" as EntityId;
const connection = {[ConnectionTag]: {key: KEY}};

describe("beginOptimisticCommentMembership — append + rollback", () => {
	it("appends the temp id into the nested connection immediately", () => {
		const store = fakeStore({ids: ["a", "b"]});
		beginOptimisticCommentMembership(store, connection, POST_ID, "temp");
		expect(store.current()?.ids).toEqual(["a", "b", "temp"]);
	});

	it("rollback restores the prior list on reject (no phantom row)", () => {
		const store = fakeStore({ids: ["a", "b"]});
		const rollback = beginOptimisticCommentMembership(store, connection, POST_ID, "temp");
		rollback();
		expect(store.current()?.ids).toEqual(["a", "b"]);
	});

	it("rollback deletes the list when there was no prior state (first comment)", () => {
		const store = fakeStore();
		const rollback = beginOptimisticCommentMembership(store, connection, POST_ID, "temp");
		expect(store.current()?.ids).toEqual(["temp"]);
		rollback();
		expect(store.current()).toBeUndefined();
	});

	it("bumps the parent post's commentCount aggregate (header + feed card agree, #2198)", () => {
		const store = fakeStore({ids: ["a"]}, {[POST_ENTITY]: {commentCount: 2}});
		beginOptimisticCommentMembership(store, connection, POST_ID, "temp");
		expect(store.record(POST_ENTITY)?.commentCount).toBe(3);
	});

	it("rollback restores commentCount on reject (no phantom bump)", () => {
		const store = fakeStore({ids: ["a"]}, {[POST_ENTITY]: {commentCount: 2}});
		const rollback = beginOptimisticCommentMembership(store, connection, POST_ID, "temp");
		expect(store.record(POST_ENTITY)?.commentCount).toBe(3);
		rollback();
		expect(store.record(POST_ENTITY)?.commentCount).toBe(2);
	});

	it("leaves commentCount untouched when the post record is not loaded", () => {
		const store = fakeStore({ids: ["a"]});
		beginOptimisticCommentMembership(store, connection, POST_ID, "temp");
		expect(store.record(POST_ENTITY)).toBeUndefined();
	});
});
