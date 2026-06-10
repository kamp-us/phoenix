/**
 * The connection plane's Schema-decoded pagination args + in-array windowing
 * (tasks.md task 16, AC "Connection args … decode via Schema with
 * fate-identical defaults").
 *
 * Parity target: fate's `paginationArgsSchema` (the ONLY runtime zod in
 * phoenix's execution path before this module replaced it) and
 * `arrayToConnection` — `@nkzw/fate` `src/server/connection.ts`. Every
 * accept/reject boundary and every windowing default below restates fate's
 * source; the walk oracle corpus (`Interpreter.test.ts`) additionally proves
 * the wire bytes against fate's real server.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Effect, Exit} from "effect";
import {describe, expect, it} from "vitest";
import {arrayToConnection, decodeConnectionPaginationArgs, getScopedArgs} from "./Connection.ts";

const decode = (args: Record<string, unknown> | undefined) =>
	Effect.runSync(Effect.exit(decodeConnectionPaginationArgs(args)));

const expectAccepted = (args: Record<string, unknown> | undefined): unknown => {
	const exit = decode(args);
	if (!Exit.isSuccess(exit)) {
		throw new Error(`expected acceptance, got: ${exit.cause}`);
	}
	return exit.value;
};

const expectRejected = (args: Record<string, unknown>): unknown => {
	const exit = decode(args);
	if (Exit.isSuccess(exit)) {
		throw new Error(`expected rejection, got: ${JSON.stringify(exit.value)}`);
	}
	return exit.cause;
};

describe("decodeConnectionPaginationArgs — fate's paginationArgsSchema as Effect Schema", () => {
	it("accepts absent and empty args as the empty window (fate's default)", () => {
		expect(expectAccepted(undefined)).toEqual({});
		expect(expectAccepted({})).toEqual({});
	});

	it("extracts ONLY the four pagination keys — feature args never reach the schema", () => {
		// fate's `extractPaginationArgs` filters before zod sees the bag, so a
		// strict schema never trips over feature args (`q`, parent keys, …).
		expect(expectAccepted({first: 2, q: "junk", parent: {id: "x"}})).toEqual({first: 2});
	});

	it("accepts each key singly and the forward first+after pairing", () => {
		expect(expectAccepted({first: 3})).toEqual({first: 3});
		expect(expectAccepted({last: 1})).toEqual({last: 1});
		expect(expectAccepted({after: "c2"})).toEqual({after: "c2"});
		expect(expectAccepted({before: "c2"})).toEqual({before: "c2"});
		expect(expectAccepted({first: 2, after: "c1"})).toEqual({after: "c1", first: 2});
	});

	it("rejects non-positive, non-integer, and non-number first/last (zod int().positive())", () => {
		expectRejected({first: 0});
		expectRejected({first: -3});
		expectRejected({first: 1.5});
		expectRejected({first: "2"});
		expectRejected({last: 0});
		expectRejected({last: 2.5});
	});

	it("rejects non-string cursors", () => {
		expectRejected({after: 7});
		expectRejected({before: true});
	});

	it("rejects after+before and first+last with fate's refine messages", () => {
		expect(String(expectRejected({after: "a", before: "b"}))).toContain(
			"Connection args can't include both 'after' and 'before'.",
		);
		expect(String(expectRejected({first: 1, last: 1}))).toContain(
			"Connection args can't include both 'first' and 'last'.",
		);
	});

	it("the refine boundary is TRUTHY, exactly like fate's zod refine", () => {
		// fate: `!(after && before)` — an empty-string cursor is falsy, so the
		// pair passes the refine. The walk oracle pins the wire consequence.
		expect(expectAccepted({after: "", before: "b"})).toEqual({after: "", before: "b"});
	});
});

describe("arrayToConnection — fate's in-array windowing, byte-shape included", () => {
	const nodes = [{id: "c1"}, {id: "c2"}, {id: "c3"}, {id: "c4"}];

	const wrap = (args: Record<string, unknown> | undefined) =>
		Effect.runSync(arrayToConnection(nodes, args));

	it("no pagination keys → every node, no windowing, no cursors (fate's empty arm)", () => {
		expect(wrap(undefined)).toEqual({
			items: nodes.map((node) => ({cursor: node.id, node})),
			pagination: {
				hasNext: false,
				hasPrevious: false,
				nextCursor: undefined,
				previousCursor: undefined,
			},
		});
		// Feature args alone do not flip into the windowing arm.
		expect(wrap({q: "junk"})).toEqual(wrap(undefined));
	});

	it("first windows forward and reports the next cursor", () => {
		expect(wrap({first: 2})).toEqual({
			items: [
				{cursor: "c1", node: {id: "c1"}},
				{cursor: "c2", node: {id: "c2"}},
			],
			pagination: {
				hasNext: true,
				hasPrevious: false,
				nextCursor: "c2",
				previousCursor: undefined,
			},
		});
	});

	it("a cursor round-trip: page 1's nextCursor is page 2's after", () => {
		const pageOne = wrap({first: 2});
		expect(wrap({first: 2, after: pageOne.pagination.nextCursor})).toEqual({
			items: [
				{cursor: "c3", node: {id: "c3"}},
				{cursor: "c4", node: {id: "c4"}},
			],
			pagination: {
				hasNext: false,
				hasPrevious: true,
				nextCursor: "c4",
				previousCursor: "c3",
			},
		});
	});

	it("after without first defaults the page size to the whole array (fate's ?? nodes.length)", () => {
		expect(wrap({after: "c1"})).toEqual({
			items: [
				{cursor: "c2", node: {id: "c2"}},
				{cursor: "c3", node: {id: "c3"}},
				{cursor: "c4", node: {id: "c4"}},
			],
			pagination: {
				hasNext: false,
				hasPrevious: true,
				nextCursor: "c4",
				previousCursor: "c2",
			},
		});
	});

	it("last/before window backward with fate's swapped hasNext/hasPrevious", () => {
		expect(wrap({last: 2})).toEqual({
			items: [
				{cursor: "c3", node: {id: "c3"}},
				{cursor: "c4", node: {id: "c4"}},
			],
			pagination: {
				hasNext: false,
				hasPrevious: true,
				nextCursor: "c4",
				previousCursor: "c3",
			},
		});
		expect(wrap({before: "c3"})).toEqual({
			items: [
				{cursor: "c1", node: {id: "c1"}},
				{cursor: "c2", node: {id: "c2"}},
			],
			pagination: {
				hasNext: true,
				hasPrevious: false,
				nextCursor: "c2",
				previousCursor: undefined,
			},
		});
	});

	it("an unknown cursor falls back to the full array (fate's findIndex < 0 arm)", () => {
		expect(wrap({first: 2, after: "nope"})).toEqual(wrap({first: 2}));
	});

	it("invalid pagination args fail with fate's wire-visible internal arm", () => {
		// In fate the zod throw rides `executeOperation`'s catch into
		// `toProtocolError` → INTERNAL_ERROR / "Internal server error." — the
		// decode failure here must surface the SAME wire arm.
		const error = Effect.runSync(Effect.flip(arrayToConnection(nodes, {first: 0})));
		expect(error).toBeInstanceOf(FateRequestError);
		expect(error.code).toBe("INTERNAL_ERROR");
		expect(error.message).toBe("Internal server error.");
	});

	it("a null node is fate's TypeError → the same internal arm", () => {
		const error = Effect.runSync(Effect.flip(arrayToConnection([null], {first: 1})));
		expect(error).toBeInstanceOf(FateRequestError);
		expect(error.code).toBe("INTERNAL_ERROR");
		expect(error.message).toBe("Internal server error.");
	});

	it("cursors stringify the node id (fate's `String(node.id)` default)", async () => {
		const numeric = Effect.runSync(arrayToConnection([{id: 42}], {first: 1}));
		expect(numeric.items[0]?.cursor).toBe("42");
	});
});

describe("getScopedArgs — fate's nested-args scoping", () => {
	it("walks the dotted path and returns the record slice", () => {
		expect(getScopedArgs({chapters: {first: 1}}, "chapters")).toEqual({first: 1});
		expect(getScopedArgs({a: {b: {c: {first: 1}}}}, "a.b.c")).toEqual({first: 1});
	});

	it("returns undefined for absent args, non-record hops, and non-record leaves", () => {
		expect(getScopedArgs(undefined, "chapters")).toBeUndefined();
		expect(getScopedArgs({chapters: "x"}, "chapters")).toBeUndefined();
		expect(getScopedArgs({chapters: [1]}, "chapters")).toBeUndefined();
		expect(getScopedArgs({other: {}}, "chapters.deep")).toBeUndefined();
	});
});

// The walk corpus (`Interpreter.test.ts`) proves the wire BYTES against
// fate's real server; this sanity pin catches an accidental defect-vs-failure
// flip early (a defect would take the WRONG taxonomy arm — `encodeWireError`'s
// INTERNAL_SERVER_ERROR instead of fate's INTERNAL_ERROR).
describe("the failure channel", () => {
	it("arrayToConnection fails (not defects) with a FateRequestError", () => {
		const error = Effect.runSync(Effect.flip(arrayToConnection([{id: "x"}], {first: 1.5})));
		expect(error).toBeInstanceOf(FateRequestError);
	});
});
