/**
 * T0 coverage for the `toConnection` adapter — the `hasNextPage`/`endCursor` →
 * `pagination` mapping reachable elsewhere only through a fuller list path
 * (ADR 0019). Forward-only, so `hasPrevious` is always `false` and `nextCursor`
 * is spread in only when `endCursor` is non-null.
 */

import {describe, expect, it} from "vitest";
import type {KeysetPage} from "./connection.ts";
import {toConnection} from "./connection.ts";

interface Row {
	readonly id: string;
}

const page = (over: Partial<KeysetPage<Row>>): KeysetPage<Row> => ({
	rows: [],
	hasNextPage: false,
	endCursor: null,
	...over,
});

const cursor = (row: Row) => `cursor:${row.id}`;
const node = (row: Row) => ({nodeId: row.id});

describe("toConnection", () => {
	it("maps rows to {cursor, node} items in order", () => {
		const result = toConnection(page({rows: [{id: "a"}, {id: "b"}]}), cursor, node);
		expect(result.items).toEqual([
			{cursor: "cursor:a", node: {nodeId: "a"}},
			{cursor: "cursor:b", node: {nodeId: "b"}},
		]);
	});

	it("with a next page: hasNext true, nextCursor is the endCursor, hasPrevious false", () => {
		const result = toConnection(
			page({rows: [{id: "a"}], hasNextPage: true, endCursor: "cursor:a"}),
			cursor,
			node,
		);
		expect(result.pagination).toEqual({
			hasNext: true,
			hasPrevious: false,
			nextCursor: "cursor:a",
		});
	});

	it("without a next page: hasNext false and nextCursor is omitted entirely", () => {
		const result = toConnection(
			page({rows: [{id: "a"}], hasNextPage: false, endCursor: null}),
			cursor,
			node,
		);
		expect(result.pagination).toEqual({hasNext: false, hasPrevious: false});
		expect(result.pagination).not.toHaveProperty("nextCursor");
	});

	it("empty page: no items, hasNext false, no nextCursor", () => {
		const result = toConnection(page({}), cursor, node);
		expect(result.items).toEqual([]);
		expect(result.pagination).toEqual({hasNext: false, hasPrevious: false});
	});
});
