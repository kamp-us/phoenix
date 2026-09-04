import {describe, expect, it} from "vitest";
import {checkTree} from "./invariants.ts";
import {createStack, createTree, createWindow, type StackNode} from "./node.ts";
import {
	find,
	findChildWindow,
	findSibling,
	remove,
	resize,
	setProcess,
	split,
	unzoom,
	zoom,
} from "./tree.ts";

const ids = (window: string, stack: string) => ({window, stack});

/** root(horizontal)[a, s(vertical)[b, c]] — one row whose right half is a column. */
const threeWindows = () =>
	createTree(
		createStack("root", "horizontal", [
			createWindow("a"),
			createStack("s", "vertical", [createWindow("b"), createWindow("c")]),
		]),
	);

describe("layout.find", () => {
	it("reaches a later sibling that follows a nested stack", () => {
		const tree = createTree(
			createStack("root", "horizontal", [
				createStack("s", "vertical", [createWindow("a"), createWindow("b")]),
				createWindow("target"),
			]),
		);

		expect(find(tree, (window) => window.id === "target")?.id).toBe("target");
	});

	it("walks every window in reading order", () => {
		const seen: string[] = [];
		find(threeWindows(), (window) => {
			seen.push(window.id);
			return false;
		});

		expect(seen).toEqual(["a", "b", "c"]);
	});
});

describe("layout.split", () => {
	it("flips a single-child stack instead of nesting one", () => {
		const tree = createTree(createStack("root", "horizontal", [createWindow("a")]));

		const next = split(tree, "a", "vertical", ids("a2", "s1"));

		expect(next.root.orientation).toBe("vertical");
		expect(next.root.children.map((child) => child.id)).toEqual(["a", "a2"]);
		expect(checkTree(next)).toEqual([]);
	});

	it("nests a stack when the orientation differs and the parent holds siblings", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b")]),
		);

		const next = split(tree, "a", "vertical", ids("a2", "s1"));
		const nested = next.root.children[0];

		expect(nested?.tag).toBe("stack");
		expect(nested?.id).toBe("s1");
		expect(next.root.orientation).toBe("horizontal");
		expect(checkTree(next)).toEqual([]);
	});

	it("appends in place when the orientation already matches", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b")]),
		);

		const next = split(tree, "a", "horizontal", ids("a2", "s1"));

		expect(next.root.children.map((child) => child.id)).toEqual(["a", "a2", "b"]);
		expect(checkTree(next)).toEqual([]);
	});

	it("seeds the new window with half the split window's share", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b")], {a: 60, b: 40}),
		);

		const next = split(tree, "a", "horizontal", ids("a2", "s1"));

		expect(next.root.sizes.a).toBeCloseTo(30, 5);
		expect(next.root.sizes.a2).toBeCloseTo(30, 5);
		expect(next.root.sizes.b).toBeCloseTo(40, 5);
		expect(sum(next.root)).toBeCloseTo(100, 5);
	});

	it("leaves the tree untouched for an unknown window or a taken id", () => {
		const tree = threeWindows();

		expect(split(tree, "nope", "vertical", ids("x", "y"))).toBe(tree);
		expect(split(tree, "a", "vertical", ids("b", "y"))).toBe(tree);
		expect(split(tree, "a", "vertical", ids("x", "s"))).toBe(tree);
	});
});

describe("layout.remove", () => {
	it("collapses an emptied stack into its grandparent", () => {
		const tree = createTree(
			createStack("root", "horizontal", [
				createWindow("a"),
				createStack("s", "vertical", [createWindow("b")]),
			]),
		);

		const next = remove(tree, "b");

		expect(next.root.children.map((child) => child.id)).toEqual(["a"]);
		expect(checkTree(next)).toEqual([]);
	});

	it("replaces a stack left holding one child with that child", () => {
		const next = remove(threeWindows(), "b");

		expect(next.root.children.map((child) => child.id)).toEqual(["a", "c"]);
		expect(checkTree(next)).toEqual([]);
	});

	it("hands the removed window's share to the sibling it sat against", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b"), createWindow("c")], {
				a: 20,
				b: 30,
				c: 50,
			}),
		);

		const next = remove(tree, "c");

		expect(next.root.sizes.a).toBeCloseTo(20, 5);
		expect(next.root.sizes.b).toBeCloseTo(80, 5);
		expect(sum(next.root)).toBeCloseTo(100, 5);
	});

	it("round-trips a split that appended beside existing siblings", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b")], {a: 60, b: 40}),
		);

		expect(remove(split(tree, "a", "horizontal", ids("a2", "s1")), "a2")).toEqual(tree);
	});

	it("round-trips a split whose parent already held siblings", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b")], {a: 60, b: 40}),
		);

		expect(remove(split(tree, "a", "vertical", ids("a2", "s1")), "a2")).toEqual(tree);
	});

	it("refuses to empty the tree", () => {
		const tree = createTree(createStack("root", "horizontal", [createWindow("a")]));

		expect(remove(tree, "a")).toBe(tree);
	});

	it("clears a zoom on the window it removes", () => {
		const zoomed = zoom(threeWindows(), "b");

		expect(remove(zoomed, "b").zoomed).toBeNull();
		expect(remove(zoomed, "c").zoomed).toBe("b");
	});
});

describe("layout.findSibling", () => {
	it("lands where tmux would from every edge of a three-window layout", () => {
		const tree = threeWindows();
		const move = (from: string, direction: "left" | "right" | "up" | "down") =>
			findSibling(tree, from, direction)?.id ?? null;

		expect(move("a", "right")).toBe("b");
		expect(move("a", "left")).toBeNull();
		expect(move("a", "up")).toBeNull();
		expect(move("a", "down")).toBeNull();

		expect(move("b", "left")).toBe("a");
		expect(move("b", "down")).toBe("c");
		expect(move("b", "up")).toBeNull();
		expect(move("b", "right")).toBeNull();

		expect(move("c", "left")).toBe("a");
		expect(move("c", "up")).toBe("b");
		expect(move("c", "down")).toBeNull();
		expect(move("c", "right")).toBeNull();
	});

	it("climbs past an ancestor laid out along the other axis", () => {
		const tree = createTree(
			createStack("root", "horizontal", [
				createWindow("a"),
				createStack("s", "vertical", [
					createStack("t", "horizontal", [createWindow("b"), createWindow("c")]),
					createWindow("d"),
				]),
			]),
		);

		expect(findSibling(tree, "c", "down")?.id).toBe("d");
		expect(findSibling(tree, "b", "left")?.id).toBe("a");
	});

	it("returns null for a window the tree does not hold", () => {
		expect(findSibling(threeWindows(), "nope", "left")).toBeNull();
	});
});

describe("layout.findChildWindow", () => {
	it("reads the window at each end of a stack's subtree", () => {
		const tree = threeWindows();

		expect(findChildWindow(tree, "root", "start")?.id).toBe("a");
		expect(findChildWindow(tree, "root", "end")?.id).toBe("c");
		expect(findChildWindow(tree, "s", "start")?.id).toBe("b");
		expect(findChildWindow(tree, "nope", "start")).toBeNull();
	});
});

describe("layout.resize", () => {
	it("normalises a reported resize back to a total map summing to 100", () => {
		const next = resize(threeWindows(), "root", {a: 30, s: 70});

		expect(next.root.sizes.a).toBeCloseTo(30, 5);
		expect(next.root.sizes.s).toBeCloseTo(70, 5);
		expect(checkTree(next)).toEqual([]);
	});

	it("gives a child the resize left unnamed an even share of the remainder", () => {
		const tree = createTree(
			createStack("root", "horizontal", [createWindow("a"), createWindow("b"), createWindow("c")]),
		);

		const next = resize(tree, "root", {a: 50});

		expect(next.root.sizes.a).toBeCloseTo(50, 5);
		expect(next.root.sizes.b).toBeCloseTo(25, 5);
		expect(next.root.sizes.c).toBeCloseTo(25, 5);
	});
});

describe("layout.zoom", () => {
	it("never writes sizes", () => {
		const tree = threeWindows();

		const zoomed = zoom(tree, "b");

		expect(zoomed.zoomed).toBe("b");
		expect(zoomed.root).toBe(tree.root);
		expect(unzoom(zoomed)).toEqual(tree);
	});

	it("ignores a window the tree does not hold", () => {
		const tree = threeWindows();

		expect(zoom(tree, "nope")).toBe(tree);
	});
});

describe("layout.setProcess", () => {
	it("attaches and detaches a process without touching the rest of the window", () => {
		const attached = setProcess(threeWindows(), "b", "process-1");

		expect(find(attached, (window) => window.id === "b")).toEqual({
			tag: "window",
			id: "b",
			processId: "process-1",
		});
		expect(find(setProcess(attached, "b", null), (w) => w.id === "b")?.processId).toBeNull();
	});
});

describe("layout.checkTree", () => {
	it("names a non-root stack holding one child, and lets the root hold one", () => {
		const tree = {
			root: {
				tag: "stack",
				id: "root",
				orientation: "horizontal",
				children: [
					{
						tag: "stack",
						id: "s",
						orientation: "vertical",
						children: [{tag: "window", id: "a", processId: null}],
						sizes: {a: 100},
					},
				],
				sizes: {s: 100},
			},
			zoomed: null,
		} as const;

		expect(checkTree(tree)).toEqual([{kind: "redundant-stack", id: "s"}]);
	});

	it("names an empty stack, an unknown size key and a missing zoom target", () => {
		const tree = {
			root: {
				tag: "stack",
				id: "root",
				orientation: "horizontal",
				children: [
					{tag: "window", id: "a", processId: null},
					{tag: "stack", id: "s", orientation: "vertical", children: [], sizes: {}},
				],
				sizes: {a: 50, s: 50, ghost: 0},
			},
			zoomed: "nope",
		} as const;

		expect(checkTree(tree)).toEqual([
			{kind: "sizes-key-unknown", stackId: "root", id: "ghost"},
			{kind: "empty-stack", id: "s"},
			{kind: "zoomed-window-missing", id: "nope"},
		]);
	});

	it("accepts a tree the constructors built", () => {
		expect(checkTree(threeWindows())).toEqual([]);
	});
});

const sum = (stack: StackNode) =>
	Object.values(stack.sizes).reduce((total, value) => total + value, 0);
