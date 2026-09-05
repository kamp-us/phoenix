/**
 * The transcript stitch, without a DOM. Everything the component decides about *which* rows exist —
 * the single head row, the page cursor, the anchor lookup, the de-duplication a prepend needs — is
 * decided here, so it is proven here.
 */

import {describe, expect, it} from "vitest";
import {assistantItem, call, transcriptOf, userItem} from "./chat.testing.ts";
import {chatRows, mergeOlder, oldestLoadedId, rowIndexOfItem, rowKey} from "./rows.ts";

const base = {older: [], tail: [], omitted: 0, loading: false, atOldest: false};

describe("chatRows", () => {
	it("puts one head row above the transcript while there is history behind it", () => {
		const rows = chatRows({...base, tail: transcriptOf(3), omitted: 12});
		expect(rows.map((row) => row.kind)).toEqual(["older", "item", "item", "item"]);
		const head = rows[0];
		expect(head?.kind).toBe("older");
		if (head?.kind === "older") expect(head.items).toBe(12);
	});

	it("replaces the omitted line with the loading row rather than showing both", () => {
		const rows = chatRows({...base, tail: transcriptOf(2), omitted: 4, loading: true});
		expect(rows.map((row) => row.kind)).toEqual(["loading", "item", "item"]);
	});

	it("drops the head row at the beginning of history", () => {
		const rows = chatRows({...base, tail: transcriptOf(2), atOldest: true});
		expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
	});

	it("shows no head row on an empty transcript", () => {
		expect(chatRows(base)).toEqual([]);
	});

	it("puts the walked-back pages before the live tail and drops what the tail already holds", () => {
		const older = [userItem("a"), assistantItem("b"), userItem("c")];
		const tail = [userItem("c"), assistantItem("d")];
		const rows = chatRows({...base, older, tail, atOldest: true});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
});

describe("chatRows folds a subagent's calls under the call that spawned it", () => {
	const group = [
		call("agent", {name: "Agent"}),
		call("child-1", {parentId: "agent"}),
		call("child-2", {parentId: "agent"}),
		call("own", {name: "Bash"}),
	];

	it("shows the group head with its count and hides the calls under it while collapsed", () => {
		const rows = chatRows({...base, tail: group, atOldest: true});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"agent",
			"own",
		]);
		const head = rows[0];
		expect(head?.kind === "item" && head.nestedIds).toEqual(["child-1", "child-2"]);
		expect(head?.kind === "item" && head.nested).toBe(false);
		expect(head?.kind === "item" && head.depth).toBe(0);
	});

	it("lays the folded calls out under the head once it is expanded, marked nested", () => {
		const rows = chatRows({
			...base,
			tail: group,
			atOldest: true,
			unfolded: new Set(["agent"]),
		});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"agent",
			"child-1",
			"child-2",
			"own",
		]);
		expect(rows.flatMap((row) => (row.kind === "item" && row.nested ? [row.item.id] : []))).toEqual(
			["child-1", "child-2"],
		);
	});

	it("leaves a row whose parent is not loaded in place, marked nested and heading nothing", () => {
		const orphan = call("child-1", {parentId: "agent"});
		const rows = chatRows({...base, tail: [orphan], atOldest: true});
		expect(rows).toEqual([{kind: "item", item: orphan, nestedIds: [], nested: true, depth: 1}]);
	});

	it("gives a folded row that is itself a group head its own count and its own children", () => {
		// The one-level fold used to drop this shape whole: the grandchild was skipped by the head
		// loop because its parent was present, and pushed by no other loop, so it appeared nowhere and
		// its parent's head line read no count (#8027).
		const deep = [
			call("agent", {name: "Agent"}),
			call("inner", {name: "Agent", parentId: "agent"}),
			call("leaf", {parentId: "inner"}),
		];
		const both = chatRows({
			...base,
			tail: deep,
			atOldest: true,
			unfolded: new Set(["agent", "inner"]),
		});
		expect(both).toEqual([
			{kind: "item", item: deep[0], nestedIds: ["inner"], nested: false, depth: 0},
			{kind: "item", item: deep[1], nestedIds: ["leaf"], nested: true, depth: 1},
			{kind: "item", item: deep[2], nestedIds: [], nested: true, depth: 2},
		]);

		const outerOnly = chatRows({...base, tail: deep, atOldest: true, unfolded: new Set(["agent"])});
		expect(outerOnly.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"agent",
			"inner",
		]);
		expect(outerOnly[1]?.kind === "item" && outerOnly[1].nestedIds).toEqual(["leaf"]);
	});

	it("emits every marked row exactly once even when the parent chain loops back on itself", () => {
		const cycle = [call("a", {parentId: "b"}), call("b", {parentId: "a"}), call("free")];
		const rows = chatRows({...base, tail: cycle, atOldest: true, unfolded: new Set(["a", "b"])});
		expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
			"free",
			"a",
			"b",
		]);
	});

	it("leaves a transcript with no parent marked on it exactly as it was", () => {
		const flat = [call("a"), call("b")];
		const rows = chatRows({...base, tail: flat, atOldest: true});
		expect(rows).toEqual([
			{kind: "item", item: flat[0], nestedIds: [], nested: false, depth: 0},
			{kind: "item", item: flat[1], nestedIds: [], nested: false, depth: 0},
		]);
	});
});

describe("mergeOlder", () => {
	it("prepends a page oldest-first and never doubles an item it already holds", () => {
		const held = [userItem("c"), assistantItem("d")];
		const merged = mergeOlder(held, [userItem("a"), assistantItem("b"), userItem("c")]);
		expect(merged.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("returns the same array when the page adds nothing, so no re-render is provoked", () => {
		const held = [userItem("a")];
		expect(mergeOlder(held, [userItem("a")])).toBe(held);
	});
});

describe("the page cursor and the prepend anchor", () => {
	it("names the oldest item the window holds, never the head row", () => {
		const rows = chatRows({...base, tail: transcriptOf(3), omitted: 1});
		expect(rows[0]?.kind).toBe("older");
		expect(oldestLoadedId(rows)).toBe("i0");
	});

	it("has no cursor on an empty transcript", () => {
		expect(oldestLoadedId([])).toBeNull();
	});

	it("finds the anchor row wherever the prepend moved it, head row or not", () => {
		const anchor = "i0";
		const withHead = chatRows({...base, older: transcriptOf(3, "p"), tail: transcriptOf(2)});
		const atOldest = chatRows({
			...base,
			older: transcriptOf(3, "p"),
			tail: transcriptOf(2),
			atOldest: true,
		});
		expect(rowIndexOfItem(withHead, anchor)).toBe(4);
		expect(rowIndexOfItem(atOldest, anchor)).toBe(3);
		expect(rowIndexOfItem(withHead, "nothing")).toBe(-1);
		expect(rowIndexOfItem(withHead, null)).toBe(-1);
	});
});

describe("rowKey", () => {
	it("keys an item on its own id, so a status update does not remount its row", () => {
		expect(
			rowKey({kind: "item", item: assistantItem("x"), nestedIds: [], nested: false, depth: 0}),
		).toBe("item:x");
		expect(rowKey({kind: "loading"})).toBe("loading");
		expect(rowKey({kind: "older", items: 3})).toBe("older");
	});
});
