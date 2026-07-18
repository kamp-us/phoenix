/**
 * Pure-core tests for `design-inventory` (#3155, ADR 0194): parsing the `@component`
 * JSDoc schema off fixture source into the structured inventory, the deterministic sort,
 * the fail-closed-on-zero verdict (ADR 0092), the firewall predicate, and the render.
 * No IO — the filesystem seam (read primitives, write the artifact) is crossed in
 * `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	buildInventory,
	extractFromFile,
	INVENTORY_ARTIFACT,
	isDescriptiveWriteTarget,
	NORMATIVE_MANIFEST,
	parseComponentBlock,
	renderInventory,
	type SourceFile,
} from "./design-inventory.ts";

// A fixture primitive mirroring the shipped Button.tsx annotation shape (ADR 0194 schema).
const buttonFixture = `import * as React from "react";
/**
 * @component Button
 * @whenToUse The base action control. Reach for \`variant="primary"\` for the one
 *   promoted action per view (the variant scale is the manifest's, referenced not
 *   restated — see \`design-system-manifest.md\`).
 * @slot children The button label — the accessible name comes from it.
 * @slot icon Optional leading decorative glyph; never the accessible name.
 */
export const Button = () => null;
`;

// A fixture file with TWO @component blocks plus a plain (non-component) type docblock.
const cardFixture = `/** A plain type docblock — NOT a component, must be ignored. */
export type SurfaceTone = "default";
/**
 * @component Surface
 * @whenToUse The parameterized surface shell.
 * @slot children The surface's content.
 */
export function Surface() {}
/**
 * @component Card
 * @whenToUse The opinionated default for a NEW surface.
 * @slot children The card's content.
 * @agent Prefer this composite over hand-rolling a bordered box; do not regenerate.
 */
export function Card() {}
`;

const file = (path: string, content: string): SourceFile => ({path, content});

describe("extractFromFile / parseComponentBlock — parse the @component JSDoc schema", () => {
	it("parses a single primitive: name, when-to-use, slots", () => {
		const [entry] = extractFromFile(file("Button.tsx", buttonFixture));
		expect(entry?.component).toBe("Button");
		expect(entry?.source).toBe("Button.tsx");
		expect(entry?.whenToUse).toContain("The base action control");
		// multi-line when-to-use is whitespace-normalized to one line
		expect(entry?.whenToUse).not.toContain("\n");
		expect(entry?.slots).toEqual([
			{name: "children", description: "The button label — the accessible name comes from it."},
			{name: "icon", description: "Optional leading decorative glyph; never the accessible name."},
		]);
		expect(entry?.agentDirectives).toEqual([]);
	});

	it("parses MULTIPLE @component blocks in one file and ignores non-component docblocks", () => {
		const entries = extractFromFile(file("Card.tsx", cardFixture));
		expect(entries.map((e) => e.component)).toEqual(["Surface", "Card"]);
	});

	it("captures @agent directives as protected steering", () => {
		const entries = extractFromFile(file("Card.tsx", cardFixture));
		const card = entries.find((e) => e.component === "Card");
		expect(card?.agentDirectives).toEqual([
			"Prefer this composite over hand-rolling a bordered box; do not regenerate.",
		]);
	});

	it("returns null for a block with no @component tag", () => {
		expect(parseComponentBlock("@whenToUse orphaned, no @component here", "x.tsx")).toBeNull();
	});
});

describe("buildInventory — deterministic sort + fail-closed on zero scope", () => {
	it("returns entries sorted by component name regardless of file read order", () => {
		const result = buildInventory([
			file("Card.tsx", cardFixture),
			file("Button.tsx", buttonFixture),
		]);
		expect(result.pass).toBe(true);
		if (result.pass) {
			expect(result.entries.map((e) => e.component)).toEqual(["Button", "Card", "Surface"]);
		}
	});

	it("FAILS zero-scope (fail-closed, ADR 0092) when no annotated primitive is found", () => {
		const result = buildInventory([file("plain.tsx", "export const x = 1;\n")]);
		expect(result.pass).toBe(false);
		expect(result.pass === false && result.reason).toBe("zero-scope");
	});

	it("FAILS zero-scope on an empty file list", () => {
		const result = buildInventory([]);
		expect(result.pass).toBe(false);
		expect(result.pass === false && result.reason).toBe("zero-scope");
	});
});

describe("isDescriptiveWriteTarget — the descriptive/normative firewall (ADR 0194)", () => {
	it("ADMITS only the descriptive inventory artifact", () => {
		expect(isDescriptiveWriteTarget(INVENTORY_ARTIFACT)).toBe(true);
		expect(isDescriptiveWriteTarget(`./${INVENTORY_ARTIFACT}`)).toBe(true);
	});

	it("REFUSES the normative manifest — it is never an extractor write target", () => {
		expect(isDescriptiveWriteTarget(NORMATIVE_MANIFEST)).toBe(false);
		expect(isDescriptiveWriteTarget(`./${NORMATIVE_MANIFEST}`)).toBe(false);
	});

	it("REFUSES any other path", () => {
		expect(isDescriptiveWriteTarget("apps/web/src/components/ui/Button.tsx")).toBe(false);
		expect(isDescriptiveWriteTarget("README.md")).toBe(false);
	});
});

describe("renderInventory — the curated-hybrid index", () => {
	const rendered = renderInventory(
		(() => {
			const r = buildInventory([file("Button.tsx", buttonFixture), file("Card.tsx", cardFixture)]);
			return r.pass ? r.entries : [];
		})(),
	);

	it("inlines the when-to-use core and links to source for depth", () => {
		expect(rendered).toContain("## Button");
		expect(rendered).toContain("_Source: Button.tsx_");
		expect(rendered).toContain("**When to use:** The base action control");
		expect(rendered).toContain("- `children` — The button label");
	});

	it("states the firewall and references the normative manifest without restating law", () => {
		expect(rendered).toContain("DESCRIPTIVE ONLY");
		expect(rendered).toContain(NORMATIVE_MANIFEST);
	});

	it("carries the generated marker so a reader knows not to hand-edit", () => {
		expect(rendered).toContain("GENERATED");
	});

	it("is byte-stable (no timestamp) so a drift guard reds only on real drift", () => {
		const again = renderInventory(
			(() => {
				const r = buildInventory([
					file("Card.tsx", cardFixture),
					file("Button.tsx", buttonFixture),
				]);
				return r.pass ? r.entries : [];
			})(),
		);
		expect(again).toBe(rendered);
	});
});
