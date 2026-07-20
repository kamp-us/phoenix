/**
 * The pure cores of the optimistic `definition.add` slice (#1679, epic #1637, ADR
 * 0125), tested without fate/React — the pure-core idiom of `panoSubmitArgs.unit`.
 * Covers the branch predicate + the temp-node's server-mirroring shape
 * ({@link buildOptimisticDefinition}) and the nested-list edge injection + rollback
 * ({@link appendOptimisticDefinitionEdge}) against a fake store.
 */

import {assert, describe, it} from "@effect/vitest";
import type {EntityId, List, Snapshot} from "@nkzw/fate";
import {
	appendOptimisticDefinitionEdge,
	buildOptimisticDefinition,
	type DefinitionAddStore,
} from "./definitionAddOptimistic";

const NOW = new Date("2026-07-02T00:00:00.000Z");
const now = () => NOW;

describe("buildOptimisticDefinition — the optimistic nested node", () => {
	it("disabled ⇒ undefined (the fresh-slug branch, which refetches + remounts instead)", () => {
		assert.strictEqual(
			buildOptimisticDefinition(false, {body: "b", author: "umut", authorId: "u1"}, now),
			undefined,
		);
	});

	it("enabled ⇒ a temp-id node fate reconciles to the server id", () => {
		const o = buildOptimisticDefinition(
			true,
			{body: "bir tanım", author: "umut", authorId: "u1"},
			now,
		);
		assert.ok(o, "expected the optimistic branch");
		if (!o) return;
		assert.strictEqual(o.id, `optimistic:${NOW.getTime()}`);
		assert.ok(o.id.startsWith("optimistic:"), "temp id fate reconciles to the server id");
		assert.strictEqual(o.body, "bir tanım");
		assert.strictEqual(o.author, "umut");
		assert.strictEqual(o.authorId, "u1");
	});

	it("mirrors the server fresh write — score 0, no vote, not-edited (no divergence)", () => {
		const o = buildOptimisticDefinition(true, {body: "b", author: "umut", authorId: "u1"}, now);
		assert.ok(o);
		if (!o) return;
		// score 0 / myVote null: the server inserts a 0-vote node — never a phantom self-upvote (#707).
		assert.strictEqual(o.score, 0);
		assert.strictEqual(o.myVote, null);
		// updatedAt === createdAt so EditedIndicator shows no false "düzenlendi".
		assert.strictEqual(o.createdAt, NOW);
		assert.strictEqual(o.updatedAt, NOW);
		assert.strictEqual(o.createdAt.getTime(), o.updatedAt.getTime());
	});
});

/** A fake store recording setList/restoreList + the term record, seeded per key/id. */
function fakeStore(
	lists: ReadonlyArray<readonly [string, List]>,
	records?: Record<string, Record<string, unknown>>,
): DefinitionAddStore & {
	readonly current: Map<string, List | undefined>;
	readonly record: (id: EntityId) => Record<string, unknown> | undefined;
} {
	const current = new Map<string, List | undefined>(lists.map(([k, l]) => [k, l]));
	const recs = new Map<string, Record<string, unknown>>(
		Object.entries(records ?? {}).map(([k, v]) => [k, {...v}]),
	);
	return {
		current,
		getListsForField: () => lists,
		setList: (key, state) => current.set(key, state),
		restoreList: (key, state) => current.set(key, state),
		read: (id) => recs.get(id),
		merge: (id, partial) => void recs.set(id, {...(recs.get(id) ?? {}), ...partial}),
		snapshot: (id): Snapshot => ({record: {...recs.get(id)}}),
		restore: (id, snap) => void recs.set(id, {...(snap.record ?? {})}),
		record: (id) => recs.get(id),
	};
}

describe("appendOptimisticDefinitionEdge — nested-list injection + rollback", () => {
	const TERM = "Term:react" as EntityId;
	const TEMP = "Definition:optimistic:123" as EntityId;

	it("appends the temp entity id to the tail of each backing list", () => {
		const store = fakeStore([["list-1", {ids: ["Definition:a", "Definition:b"]}]]);
		appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.deepStrictEqual(store.current.get("list-1")?.ids, [
			"Definition:a",
			"Definition:b",
			TEMP,
		]);
	});

	it("keeps cursors aligned — pushes an undefined cursor for the temp node", () => {
		const store = fakeStore([["list-1", {ids: ["Definition:a"], cursors: ["c-a"]}]]);
		appendOptimisticDefinitionEdge(store, TERM, TEMP);
		const next = store.current.get("list-1");
		assert.deepStrictEqual(next?.ids, ["Definition:a", TEMP]);
		assert.deepStrictEqual(next?.cursors, ["c-a", undefined]);
	});

	it("rollback restores each list to its pre-insert snapshot (removes the temp edge)", () => {
		const original: List = {ids: ["Definition:a", "Definition:b"], cursors: ["c-a", "c-b"]};
		const store = fakeStore([["list-1", original]]);
		const rollback = appendOptimisticDefinitionEdge(store, TERM, TEMP);
		rollback();
		assert.strictEqual(store.current.get("list-1"), original);
	});

	it("injects into every backing list of the field", () => {
		const store = fakeStore([
			["list-first-50", {ids: ["Definition:a"]}],
			["list-other", {ids: ["Definition:a", "Definition:c"]}],
		]);
		appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.deepStrictEqual(store.current.get("list-first-50")?.ids, ["Definition:a", TEMP]);
		assert.deepStrictEqual(store.current.get("list-other")?.ids, [
			"Definition:a",
			"Definition:c",
			TEMP,
		]);
	});

	it("no-op with an empty rollback when the term has no loaded list (fresh-slug branch)", () => {
		const store = fakeStore([]);
		const rollback = appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.strictEqual(typeof rollback, "function");
		rollback(); // must not throw
		assert.strictEqual(store.current.size, 0);
	});

	it("bumps BOTH count (header) and definitionCount (index) aggregates by one (#2198)", () => {
		const store = fakeStore([["list-1", {ids: ["Definition:a"]}]], {
			[TERM]: {count: 2, definitionCount: 2},
		});
		appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.strictEqual(store.record(TERM)?.count, 3);
		assert.strictEqual(store.record(TERM)?.definitionCount, 3);
	});

	it("bumps only the loaded scalar — term page carries `count`, not `definitionCount`", () => {
		const store = fakeStore([["list-1", {ids: []}]], {[TERM]: {count: 2}});
		appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.strictEqual(store.record(TERM)?.count, 3);
		assert.strictEqual(store.record(TERM)?.definitionCount, undefined);
	});

	it("rollback restores the bumped aggregates on a rejected add (no phantom count)", () => {
		const store = fakeStore([["list-1", {ids: ["Definition:a"]}]], {
			[TERM]: {count: 2, definitionCount: 2},
		});
		const rollback = appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.strictEqual(store.record(TERM)?.count, 3);
		rollback();
		assert.strictEqual(store.record(TERM)?.count, 2);
		assert.strictEqual(store.record(TERM)?.definitionCount, 2);
	});

	it("leaves the aggregate untouched when the term record is not loaded", () => {
		const store = fakeStore([["list-1", {ids: []}]]);
		appendOptimisticDefinitionEdge(store, TERM, TEMP);
		assert.strictEqual(store.record(TERM), undefined);
	});
});
