/**
 * The optimistic `comment.add` core (#1678, epic #1637; A1 per ADR 0125), tested
 * off the REAL exported functions the call site routes through — no DOM, no fate
 * client (the pure-core idiom of `panoSubmitArgs.unit.test` / `optimisticEdit.test`).
 * Covers the flag gate + payload (temp id, no phantom self-upvote #707), the pure
 * append/remove list ops (dedup + rollback), and the store-shim append+rollback
 * against a fake `NestedListStore`. fate's own reconcile/rollback of the entity is
 * exercised at the integration tier.
 */
import {type EntityId, type List, toEntityId} from "@nkzw/fate";
import {describe, expect, it} from "vitest";
import {
	appendEntityIdVisible,
	beginOptimisticCommentAppend,
	commentAddOptimistic,
	connectionListKey,
	type NestedListStore,
	removeEntityId,
	TEMP_COMMENT_ID_PREFIX,
	tempCommentEntityId,
} from "./optimisticCommentAdd";

const fixedNow = () => new Date("2026-07-02T12:00:00.000Z");
const NOW_MS = fixedNow().getTime();

const input = {parentId: null, body: "merhaba", author: "umut", authorId: "user-1"} as const;

describe("commentAddOptimistic — the flag gate + payload", () => {
	it("returns undefined when the flag is off (plain round-trip, as today)", () => {
		expect(commentAddOptimistic(false, input, fixedNow)).toBeUndefined();
	});

	it("builds a temp-id node fate reconciles to the server id when the flag is on", () => {
		const node = commentAddOptimistic(true, input, fixedNow);
		expect(node).toEqual({
			id: `${TEMP_COMMENT_ID_PREFIX}${NOW_MS}`,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user-1",
			score: 0,
			myVote: null,
			createdAt: fixedNow(),
			updatedAt: fixedNow(),
			deletedAt: null,
		});
		expect(node?.id.startsWith(TEMP_COMMENT_ID_PREFIX)).toBe(true);
	});

	it("carries a fresh comment's initial state — never a phantom self-upvote (#707)", () => {
		const node = commentAddOptimistic(true, input, fixedNow);
		expect(node?.score).toBe(0);
		expect(node?.myVote).toBe(null);
		expect(node?.deletedAt).toBe(null);
	});

	it("threads a reply's parentId through", () => {
		const node = commentAddOptimistic(true, {...input, parentId: "c-9"}, fixedNow);
		expect(node?.parentId).toBe("c-9");
	});
});

describe("tempCommentEntityId — the store entity id", () => {
	it("is the Comment-typed entity id of the temp node", () => {
		const node = commentAddOptimistic(true, input, fixedNow);
		if (!node) throw new Error("expected a node");
		expect(tempCommentEntityId(node)).toBe(
			toEntityId("Comment", `${TEMP_COMMENT_ID_PREFIX}${NOW_MS}`),
		);
	});
});

const makeList = (ids: EntityId[], cursors?: Array<string | undefined>): List => ({
	ids,
	...(cursors ? {cursors} : {}),
});

describe("appendEntityIdVisible — the visible-append list op", () => {
	it("appends the id to the end of a visible list", () => {
		const next = appendEntityIdVisible(
			makeList(["Comment:a" as EntityId]),
			"Comment:b" as EntityId,
		);
		expect(next.ids).toEqual(["Comment:a", "Comment:b"]);
	});

	it("is idempotent — an already-present id is not doubled", () => {
		const list = makeList(["Comment:a" as EntityId]);
		expect(appendEntityIdVisible(list, "Comment:a" as EntityId)).toBe(list);
	});

	it("extends a parallel cursors array so it stays aligned with ids", () => {
		const next = appendEntityIdVisible(
			makeList(["Comment:a" as EntityId], ["cur-a"]),
			"Comment:b" as EntityId,
		);
		expect(next.cursors).toEqual(["cur-a", undefined]);
	});
});

describe("removeEntityId — the rollback list op", () => {
	it("removes the id and its parallel cursor (targeted, keeps siblings)", () => {
		const next = removeEntityId(
			makeList(["Comment:a", "Comment:b", "Comment:c"] as EntityId[], [
				"cur-a",
				undefined,
				"cur-c",
			]),
			"Comment:b" as EntityId,
		);
		expect(next.ids).toEqual(["Comment:a", "Comment:c"]);
		expect(next.cursors).toEqual(["cur-a", "cur-c"]);
	});

	it("is idempotent — an absent id returns the same list", () => {
		const list = makeList(["Comment:a" as EntityId]);
		expect(removeEntityId(list, "Comment:zzz" as EntityId)).toBe(list);
	});
});

describe("connectionListKey — reading the nested list key off ConnectionTag", () => {
	it("returns null for a connection with no ConnectionTag metadata", () => {
		expect(connectionListKey({})).toBe(null);
		expect(connectionListKey(null)).toBe(null);
		expect(connectionListKey(undefined)).toBe(null);
	});
});

describe("beginOptimisticCommentAppend — apply + rollback against a fake store", () => {
	const KEY = "Post:p1.comments";
	const TEMP = "Comment:optimistic:1" as EntityId;

	function fakeStore(initial: List | undefined): NestedListStore & {state: List | undefined} {
		let state = initial;
		return {
			get state() {
				return state;
			},
			getListState: () => state,
			setList: (_key, next) => {
				state = next;
			},
		};
	}

	it("inserts the temp id into the nested list", () => {
		const store = fakeStore(makeList(["Comment:a" as EntityId]));
		beginOptimisticCommentAppend(store, KEY, TEMP);
		expect(store.state?.ids).toEqual(["Comment:a", TEMP]);
	});

	it("its rollback removes exactly the temp id (leaves siblings)", () => {
		const store = fakeStore(makeList(["Comment:a" as EntityId]));
		const rollback = beginOptimisticCommentAppend(store, KEY, TEMP);
		rollback();
		expect(store.state?.ids).toEqual(["Comment:a"]);
	});

	it("rollback survives a concurrent live append (only the temp id leaves)", () => {
		const store = fakeStore(makeList(["Comment:a" as EntityId]));
		const rollback = beginOptimisticCommentAppend(store, KEY, TEMP);
		// another author's comment lands live while the add is in flight
		store.setList(KEY, appendEntityIdVisible(store.state as List, "Comment:live" as EntityId));
		rollback();
		expect(store.state?.ids).toEqual(["Comment:a", "Comment:live"]);
	});

	it("no-ops with a null list key (unresolved connection ⇒ plain round-trip)", () => {
		const store = fakeStore(makeList(["Comment:a" as EntityId]));
		const rollback = beginOptimisticCommentAppend(store, null, TEMP);
		expect(store.state?.ids).toEqual(["Comment:a"]);
		expect(() => rollback()).not.toThrow();
	});

	it("no-ops when the list state is absent yet", () => {
		const store = fakeStore(undefined);
		const rollback = beginOptimisticCommentAppend(store, KEY, TEMP);
		expect(store.state).toBeUndefined();
		expect(() => rollback()).not.toThrow();
	});
});
