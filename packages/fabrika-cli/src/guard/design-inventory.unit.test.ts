/**
 * The `design-inventory` extractor and its firewall — the `design-inventory.unit.test.ts` cases from
 * the v1 CLI.
 */
import {describe, expect, it} from "vitest";
import {
	buildInventory,
	extractFromFile,
	extractJsdocBlocks,
	INVENTORY_ARTIFACT,
	isDescriptiveWriteTarget,
	NORMATIVE_MANIFEST,
	parseComponentBlock,
	renderInventory,
	type SourceFile,
} from "./design-inventory.ts";

const source = (content: string, path = "apps/web/src/components/ui/Alert.tsx"): SourceFile => ({
	path,
	content,
});

const ALERT = `
/**
 * @component Alert
 * @whenToUse For a message that
 *   needs the reader's attention.
 * @slot title The heading line.
 * @slot body
 * @agent Never nest an Alert inside an Alert.
 */
export const Alert = () => null;
`;

describe("extractJsdocBlocks", () => {
	it("strips the per-line decoration", () => {
		expect(extractJsdocBlocks("/**\n * a\n * b\n */")).toEqual(["\na\nb\n"]);
	});

	it("returns every block in a file", () => {
		expect(extractJsdocBlocks("/** a */\ncode\n/** b */")).toHaveLength(2);
	});
});

describe("parseComponentBlock", () => {
	it("reads the tag vocabulary off one block", () => {
		const entry = parseComponentBlock(extractJsdocBlocks(ALERT)[0] ?? "", "x.tsx");
		expect(entry).toEqual({
			component: "Alert",
			source: "x.tsx",
			whenToUse: "For a message that needs the reader's attention.",
			slots: [
				{name: "title", description: "The heading line."},
				{name: "body", description: ""},
			],
			agentDirectives: ["Never nest an Alert inside an Alert."],
		});
	});

	it("ignores a block that documents something other than a component", () => {
		expect(parseComponentBlock("@param x a prop", "x.tsx")).toBeNull();
	});

	it("ignores a bare @component with no name", () => {
		expect(parseComponentBlock("@component", "x.tsx")).toBeNull();
	});
});

describe("buildInventory", () => {
	// Byte-stability under a shuffled read order is what the freshness check rests on: without it
	// the guard would red on filesystem ordering rather than on drift.
	it("sorts entries so the render is order-independent", () => {
		const b = source("/**\n * @component Badge\n */", "b.tsx");
		const a = source("/**\n * @component Alert\n */", "a.tsx");
		const forward = buildInventory([a, b]);
		const reversed = buildInventory([b, a]);
		expect(forward).toEqual(reversed);
	});

	it("fails closed when no primitive is annotated", () => {
		expect(buildInventory([source("export const X = () => null;")])).toEqual({
			pass: false,
			reason: "zero-scope",
		});
	});

	it("takes several components from one file", () => {
		expect(
			extractFromFile(source("/**\n * @component A\n */\n/**\n * @component B\n */")),
		).toHaveLength(2);
	});
});

describe("isDescriptiveWriteTarget", () => {
	it("admits the inventory artifact", () => {
		expect(isDescriptiveWriteTarget(INVENTORY_ARTIFACT)).toBe(true);
		expect(isDescriptiveWriteTarget(`./${INVENTORY_ARTIFACT}`)).toBe(true);
	});

	// The firewall's whole point: the founder-authored law is not writable from the extractor.
	it("refuses the normative manifest", () => {
		expect(isDescriptiveWriteTarget(NORMATIVE_MANIFEST)).toBe(false);
	});

	it("refuses anything else", () => {
		expect(isDescriptiveWriteTarget("README.md")).toBe(false);
	});
});

describe("renderInventory", () => {
	const rendered = () => {
		const result = buildInventory([source(ALERT)]);
		return result.pass ? renderInventory(result.entries) : "";
	};

	it("states the firewall in the header and points at the law", () => {
		expect(rendered()).toContain("DESCRIPTIVE ONLY");
		expect(rendered()).toContain(NORMATIVE_MANIFEST);
	});

	it("marks agent directives as protected", () => {
		expect(rendered()).toContain("do not regenerate");
	});

	// No timestamp: two runs over one tree must produce identical bytes or the check reds on nothing.
	it("renders identically on a re-run", () => {
		expect(rendered()).toBe(rendered());
	});
});
