import fc from "fast-check";
import {describe, expect, it} from "vitest";
import {checkTree} from "./invariants.ts";
import {
	createStack,
	createTree,
	createWindow,
	type LayoutNode,
	type LayoutTree,
	type Orientation,
} from "./node.ts";
import {findSibling, remove, resize, split, windows} from "./tree.ts";

interface SplitStep {
	readonly at: number;
	readonly orientation: Orientation;
}

const orientation = fc.constantFrom<Orientation>("horizontal", "vertical");

const splitSteps = fc.array(fc.record({at: fc.nat(), orientation}), {maxLength: 12});

const seed = () => createTree(createStack("root", "horizontal", [createWindow("w0")]));

function build(steps: readonly SplitStep[]): LayoutTree {
	let tree = seed();
	steps.forEach((step, index) => {
		const open = [...windows(tree.root)];
		const target = open[step.at % open.length];
		if (!target) return;
		tree = split(tree, target.id, step.orientation, {
			window: `w${index + 1}`,
			stack: `s${index + 1}`,
		});
	});
	return tree;
}

const trees = splitSteps.map(build);

/**
 * A stack holding one child renders the same whichever orientation it carries, so `split`'s flip of
 * a single-child stack is not observable and `remove` cannot restore it. Shares compare to 6
 * decimals: the scaling in `resolveSizes` is float arithmetic.
 */
function normalise(node: LayoutNode): LayoutNode {
	if (node.tag === "window") return node;
	const sizes: Record<string, number> = {};
	for (const [id, value] of Object.entries(node.sizes)) {
		sizes[id] = Number(value.toFixed(6));
	}
	return {
		...node,
		orientation: node.children.length === 1 ? "horizontal" : node.orientation,
		children: node.children.map(normalise),
		sizes,
	};
}

const same = (left: LayoutTree, right: LayoutTree) =>
	expect(normalise(left.root)).toEqual(normalise(right.root));

describe("layout properties", () => {
	it("keeps every invariant under any sequence of splits", () => {
		fc.assert(
			fc.property(trees, (tree) => {
				expect(checkTree(tree)).toEqual([]);
				expect([...windows(tree.root)].every((window) => window.tag === "window")).toBe(true);
			}),
		);
	});

	it("keeps every invariant under any removal", () => {
		fc.assert(
			fc.property(trees, fc.nat(), (tree, pick) => {
				const open = [...windows(tree.root)];
				const target = open[pick % open.length];
				if (!target) return;
				expect(checkTree(remove(tree, target.id))).toEqual([]);
			}),
		);
	});

	it("round-trips a removal after the split that created the window", () => {
		fc.assert(
			fc.property(trees, fc.nat(), orientation, (tree, pick, splitOrientation) => {
				const open = [...windows(tree.root)];
				const target = open[pick % open.length];
				if (!target) return;
				const grown = split(tree, target.id, splitOrientation, {window: "fresh", stack: "nest"});
				same(remove(grown, "fresh"), tree);
			}),
		);
	});

	it("keeps every invariant under any resize of any stack", () => {
		fc.assert(
			fc.property(
				trees,
				fc.dictionary(fc.string(), fc.double({min: 0, max: 100, noNaN: true})),
				(tree, sizes) => {
					expect(checkTree(resize(tree, "root", sizes))).toEqual([]);
				},
			),
		);
	});

	it("only ever moves focus to a window the tree holds", () => {
		fc.assert(
			fc.property(
				trees,
				fc.nat(),
				fc.constantFrom("left" as const, "right" as const, "up" as const, "down" as const),
				(tree, pick, direction) => {
					const open = [...windows(tree.root)];
					const target = open[pick % open.length];
					if (!target) return;
					const landed = findSibling(tree, target.id, direction);
					if (landed === null) return;
					expect(open.map((window) => window.id)).toContain(landed.id);
					expect(landed.id).not.toBe(target.id);
				},
			),
		);
	});
});
