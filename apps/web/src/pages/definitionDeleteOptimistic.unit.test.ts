/**
 * The pure core of the optimistic `definition.delete` slice (#1681, epic #1637, ADR
 * 0125 D1), tested without fate/React — the pure-core idiom of the add-side sibling
 * `definitionAddOptimistic.unit`. Covers the nested-list edge drop + rollback
 * ({@link dropOptimisticDefinitionEdge}) against a fake store: the drop reconciles
 * against the server `deleteEdge` by canonical id (no reappear), and rollback
 * restores the edge on rejection.
 */

import {assert, describe, it} from "@effect/vitest";
import type {List} from "@nkzw/fate";
import type {DefinitionListStore} from "./definitionAddOptimistic";
import {dropOptimisticDefinitionEdge} from "./definitionDeleteOptimistic";

/** A fake store recording setList/restoreList, seeded with per-key list snapshots. */
function fakeStore(lists: ReadonlyArray<readonly [string, List]>): DefinitionListStore & {
	readonly current: Map<string, List | undefined>;
} {
	const current = new Map<string, List | undefined>(lists.map(([k, l]) => [k, l]));
	return {
		current,
		getListsForField: () => lists,
		setList: (key, state) => current.set(key, state),
		restoreList: (key, state) => current.set(key, state),
	};
}

describe("dropOptimisticDefinitionEdge — nested-list edge drop + rollback", () => {
	const TERM = "Term:react";
	const TARGET = "Definition:b";

	it("drops the target entity id from each backing list", () => {
		const store = fakeStore([["list-1", {ids: ["Definition:a", "Definition:b", "Definition:c"]}]]);
		dropOptimisticDefinitionEdge(store, TERM, TARGET);
		assert.deepStrictEqual(store.current.get("list-1")?.ids, ["Definition:a", "Definition:c"]);
	});

	it("keeps cursors aligned — removes the cursor at the dropped id's index", () => {
		const store = fakeStore([
			[
				"list-1",
				{ids: ["Definition:a", "Definition:b", "Definition:c"], cursors: ["c-a", "c-b", "c-c"]},
			],
		]);
		dropOptimisticDefinitionEdge(store, TERM, TARGET);
		const next = store.current.get("list-1");
		assert.deepStrictEqual(next?.ids, ["Definition:a", "Definition:c"]);
		assert.deepStrictEqual(next?.cursors, ["c-a", "c-c"]);
	});

	it("rollback restores each list to its pre-drop snapshot (re-adds the edge)", () => {
		const original: List = {ids: ["Definition:a", "Definition:b"], cursors: ["c-a", "c-b"]};
		const store = fakeStore([["list-1", original]]);
		const rollback = dropOptimisticDefinitionEdge(store, TERM, TARGET);
		assert.deepStrictEqual(store.current.get("list-1")?.ids, ["Definition:a"]);
		rollback();
		assert.strictEqual(store.current.get("list-1"), original);
	});

	it("drops from every backing list of the field that carries the id", () => {
		const store = fakeStore([
			["list-first-50", {ids: ["Definition:a", "Definition:b"]}],
			["list-other", {ids: ["Definition:b", "Definition:c"]}],
		]);
		dropOptimisticDefinitionEdge(store, TERM, TARGET);
		assert.deepStrictEqual(store.current.get("list-first-50")?.ids, ["Definition:a"]);
		assert.deepStrictEqual(store.current.get("list-other")?.ids, ["Definition:c"]);
	});

	it("leaves a list that doesn't carry the id untouched", () => {
		const untouched: List = {ids: ["Definition:a", "Definition:c"]};
		const store = fakeStore([["list-1", untouched]]);
		dropOptimisticDefinitionEdge(store, TERM, TARGET);
		assert.strictEqual(store.current.get("list-1"), untouched);
	});

	it("reconciles by canonical id — a redundant drop of an already-gone id is a no-op (no reappear)", () => {
		// Models the server `deleteEdge` frame landing after the optimistic drop: the id
		// is already absent, so removing it again changes nothing — one absent edge.
		const store = fakeStore([["list-1", {ids: ["Definition:a", "Definition:c"]}]]);
		dropOptimisticDefinitionEdge(store, TERM, TARGET);
		assert.deepStrictEqual(store.current.get("list-1")?.ids, ["Definition:a", "Definition:c"]);
	});

	it("no-op with an empty rollback when the term has no loaded list", () => {
		const store = fakeStore([]);
		const rollback = dropOptimisticDefinitionEdge(store, TERM, TARGET);
		assert.strictEqual(typeof rollback, "function");
		rollback(); // must not throw
		assert.strictEqual(store.current.size, 0);
	});
});
