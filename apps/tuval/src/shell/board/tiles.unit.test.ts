/**
 * The board's tile model, without a DOM. What the tiles *look* like is
 * `./process-board.unit.test.tsx`; what they *are* is here.
 */

import {Option} from "effect";
import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {PortDeclaration, TableRow} from "../../table/row.ts";
import {enteredSince, tileIds, tilesOf} from "./tiles.ts";

const outPort: PortDeclaration = {kind: "tuval/title/v1", direction: "out"};

const row = (
	id: string,
	options: {
		readonly programId?: string;
		readonly parent?: string;
		readonly title?: string;
		readonly status?: string;
		readonly ports?: Readonly<Record<string, PortDeclaration>>;
		readonly lifecycle?: "running" | "stopping";
	} = {},
): TableRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make(options.programId ?? "demo/counter"),
	parentId:
		options.parent === undefined ? Option.none() : Option.some(ProcessId.make(options.parent)),
	ports: options.ports ?? {},
	stateSummary: {lifecycle: options.lifecycle ?? "running", revision: 1},
	title: options.title === undefined ? Option.none() : Option.some(options.title),
	status: options.status === undefined ? Option.none() : Option.some(options.status),
});

describe("tilesOf", () => {
	it("gives a process that declares neither generic port a whole tile", () => {
		const [tile] = tilesOf([row("p1", {programId: "demo/counter"})]);
		expect(tile).toEqual({
			processId: "p1",
			programId: "demo/counter",
			lifecycle: "running",
			title: null,
			status: null,
			ports: 0,
			children: [],
		});
	});

	it("reads the latched lines and the port count off the row", () => {
		const [tile] = tilesOf([
			row("p1", {
				title: "claude · fable · phoenix",
				status: "writing the tile model · $0.12",
				ports: {"title@1": outPort, "status@1": outPort},
			}),
		]);
		expect(tile?.title).toBe("claude · fable · phoenix");
		expect(tile?.status).toBe("writing the tile model · $0.12");
		expect(tile?.ports).toBe(2);
	});

	it("nests a child inside its parent and leaves it off the roots", () => {
		const tiles = tilesOf([row("parent"), row("child", {parent: "parent"})]);
		expect(tiles.map((tile) => tile.processId)).toEqual(["parent"]);
		expect(tiles[0]?.children.map((tile) => tile.processId)).toEqual(["child"]);
	});

	it("nests a grandchild under the child rather than flattening it", () => {
		const tiles = tilesOf([row("a"), row("b", {parent: "a"}), row("c", {parent: "b"})]);
		expect(tiles[0]?.children[0]?.children.map((tile) => tile.processId)).toEqual(["c"]);
	});

	// The promise the board makes first: every live process has a tile. A child whose parent has
	// already stopped has nowhere to nest, and dropping it would hide the process hardest to find.
	it("draws a child whose parent is not in the table as a root", () => {
		const tiles = tilesOf([row("orphan", {parent: "gone"})]);
		expect(tiles.map((tile) => tile.processId)).toEqual(["orphan"]);
	});

	it("draws a row that names itself as its parent once, at the root", () => {
		const tiles = tilesOf([row("loop", {parent: "loop"})]);
		expect(tiles.map((tile) => tile.processId)).toEqual(["loop"]);
		expect(tiles[0]?.children).toEqual([]);
	});

	it("terminates on a parent chain that loops and still names every row", () => {
		const tiles = tilesOf([row("a", {parent: "b"}), row("b", {parent: "a"})]);
		expect([...tileIds(tiles)].sort()).toEqual(["a", "b"]);
	});

	it("keeps the order the rows arrived in", () => {
		const tiles = tilesOf([row("z"), row("a"), row("m")]);
		expect(tiles.map((tile) => tile.processId)).toEqual(["z", "a", "m"]);
	});
});

describe("enteredSince", () => {
	it("answers nothing for the first board, however many processes are already running", () => {
		expect([...enteredSince(null, new Set([ProcessId.make("a"), ProcessId.make("b")]))]).toEqual(
			[],
		);
	});

	it("names only the ids the previous board did not carry", () => {
		const previous = new Set([ProcessId.make("a")]);
		const current = new Set([ProcessId.make("a"), ProcessId.make("b")]);
		expect([...enteredSince(previous, current)]).toEqual(["b"]);
	});

	it("names nothing when a process leaves", () => {
		const previous = new Set([ProcessId.make("a"), ProcessId.make("b")]);
		expect([...enteredSince(previous, new Set([ProcessId.make("a")]))]).toEqual([]);
	});
});
