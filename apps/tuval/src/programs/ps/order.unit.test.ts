import {describe, expect, it} from "vitest";
import {tableRowsFromSnapshot} from "../engine-view/snapshot-rows.ts";
import {psColumn, psColumnOrder} from "./columns.ts";
import {processId, row, tiedRows, twoRootForest} from "./fixtures.ts";
import {defaultOrder, orderedRows, resolveSelection, sortRows} from "./order.ts";

const ids = (rows: ReadonlyArray<{readonly id: unknown}>): ReadonlyArray<string> =>
	rows.map((each) => String(each.id));

const forest = tableRowsFromSnapshot(twoRootForest);

describe("defaultOrder", () => {
	it("puts a parent immediately before its children, siblings by process id", () => {
		expect(ids(defaultOrder(forest))).toEqual([
			"root-a",
			"child-a1",
			"grandchild-a1",
			"child-a2",
			"root-b",
			"child-b1",
		]);
	});

	it("keeps every other row in place when a live update adds and removes one", () => {
		const before = ids(defaultOrder(forest));
		const after = ids(
			defaultOrder(
				tableRowsFromSnapshot([
					...twoRootForest.filter((each) => String(each.id) !== "child-a2"),
					row("child-b2", {parent: "root-b"}),
				]),
			),
		);
		expect(after).toEqual([
			"root-a",
			"child-a1",
			"grandchild-a1",
			"root-b",
			"child-b1",
			"child-b2",
		]);
		// Every survivor keeps the relative position it had, which is the whole promise.
		expect(after.filter((id) => before.includes(id))).toEqual(
			before.filter((id) => after.includes(id)),
		);
	});

	it("treats a row whose parent has left the table as a root rather than dropping it", () => {
		const orphaned = tableRowsFromSnapshot(
			twoRootForest.filter((each) => String(each.id) !== "child-a1"),
		);
		expect(ids(defaultOrder(orphaned))).toEqual([
			"grandchild-a1",
			"root-a",
			"child-a2",
			"root-b",
			"child-b1",
		]);
	});

	it("emits every row exactly once even when the rows describe a cycle", () => {
		const cyclic = tableRowsFromSnapshot([
			row("a", {parent: "b"}),
			row("b", {parent: "c"}),
			row("c", {parent: "a"}),
		]);
		expect(ids(defaultOrder(cyclic))).toEqual(["a", "c", "b"]);
	});
});

describe("sortRows", () => {
	/** The comparison the column declares, restated so the test asserts the property, not the code. */
	const compare = (left: string | number, right: string | number): number =>
		typeof left === "number" && typeof right === "number"
			? left - right
			: String(left).localeCompare(String(right));

	const ordered = (keys: ReadonlyArray<string | number>, sign: number): boolean =>
		keys.every(
			(key, index) => index === 0 || compare(keys[index - 1] as string | number, key) * sign <= 0,
		);

	for (const column of psColumnOrder) {
		it(`sorts the ${column} column both directions`, () => {
			const key = psColumn(column).sortKey;
			const ascending = sortRows(forest, column, "ascending");
			const descending = sortRows(forest, column, "descending");

			expect([...ids(ascending)].sort()).toEqual([...ids(forest)].sort());
			expect([...ids(descending)].sort()).toEqual([...ids(forest)].sort());
			expect(ordered(ascending.map(key), 1)).toBe(true);
			expect(ordered(descending.map(key), -1)).toBe(true);
		});
	}

	it("keeps the default order for equal keys, in both directions", () => {
		const tied = tableRowsFromSnapshot(tiedRows);
		const expected = ids(defaultOrder(tied));
		expect(ids(sortRows(tied, "revision", "ascending"))).toEqual(expected);
		expect(ids(sortRows(tied, "revision", "descending"))).toEqual(expected);
		expect(ids(sortRows(tied, "program", "descending"))).toEqual(expected);
	});

	it("orders the revision column numerically, not lexically", () => {
		const rows = tableRowsFromSnapshot([
			row("a", {revision: 2}),
			row("b", {revision: 10}),
			row("c", {revision: 9}),
		]);
		expect(ids(sortRows(rows, "revision", "ascending"))).toEqual(["a", "c", "b"]);
	});
});

describe("orderedRows", () => {
	it("is the default order when no column is sorted", () => {
		expect(ids(orderedRows(forest, null, "ascending"))).toEqual(ids(defaultOrder(forest)));
		expect(ids(orderedRows(forest, null, "descending"))).toEqual(ids(defaultOrder(forest)));
	});

	it("is the column's sort when one is", () => {
		expect(ids(orderedRows(forest, "revision", "ascending"))).toEqual(
			ids(sortRows(forest, "revision", "ascending")),
		);
	});
});

describe("resolveSelection", () => {
	it("keeps a selection the table still holds", () => {
		expect(resolveSelection(processId("child-a1"), forest)).toBe(processId("child-a1"));
	});

	it("drops a selection whose process has left the table", () => {
		const remaining = tableRowsFromSnapshot(
			twoRootForest.filter((each) => String(each.id) !== "child-a1"),
		);
		expect(resolveSelection(processId("child-a1"), remaining)).toBeNull();
	});

	it("answers none for no selection", () => {
		expect(resolveSelection(null, forest)).toBeNull();
	});
});
