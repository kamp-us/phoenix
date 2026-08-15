import {describe, expect, it} from "vitest";
import {AUTHORED, CLEARED_DECISIONS} from "./fixtures.test-support.ts";
import {
	AUTHORED_SECTIONS,
	carriesDecisionsHeading,
	checkSections,
	composeSpec,
	readDecisionsSection,
	renderDecision,
	renderFooter,
	SPEC_SECTIONS,
	unplacedContent,
	withFooter,
} from "./spec.ts";
import type {DecisionRow} from "./trail.ts";

describe("content the composed spec would not carry", () => {
	it("finds nothing in a body holding exactly the three sections", () => {
		expect(unplacedContent(AUTHORED, AUTHORED_SECTIONS)).toBeNull();
	});

	it("names a fourth section rather than letting compose drop it", () => {
		expect(unplacedContent(`${AUTHORED}\n## Risks\nr\n`, AUTHORED_SECTIONS)).toEqual({
			_tag: "Heading",
			heading: "## Risks",
		});
	});

	it("names a preamble above the first heading", () => {
		expect(unplacedContent(`intro prose\n\n${AUTHORED}`, AUTHORED_SECTIONS)).toEqual({
			_tag: "Preamble",
		});
	});
});

describe("the authored section floor", () => {
	it("passes the three sections in order", () => {
		expect(checkSections(AUTHORED, AUTHORED_SECTIONS)).toBeNull();
	});

	it("names a missing section", () => {
		expect(checkSections("## Problem\nx\n\n## Solution\ny\n", AUTHORED_SECTIONS)).toEqual({
			_tag: "Missing",
			heading: "## Out of scope",
		});
	});

	it("names an empty section", () => {
		expect(
			checkSections("## Problem\n\n## Solution\ny\n\n## Out of scope\nz\n", AUTHORED_SECTIONS),
		).toEqual({_tag: "Empty", heading: "## Problem"});
	});

	it("names the pair that is out of order", () => {
		expect(
			checkSections("## Solution\ny\n\n## Problem\nx\n\n## Out of scope\nz\n", AUTHORED_SECTIONS),
		).toEqual({_tag: "OutOfOrder", heading: "## Problem", after: "## Solution"});
	});

	it("sees a `## Decisions` heading on an authored body", () => {
		expect(carriesDecisionsHeading(AUTHORED)).toBe(false);
		expect(carriesDecisionsHeading(`${AUTHORED}\n## Decisions\n- mine\n`)).toBe(true);
	});
});

describe("the rendered decisions section", () => {
	it("renders the provenance in bold and the ref once, with no repeated source number", () => {
		expect(renderDecision(CLEARED_DECISIONS[1] as DecisionRow)).toBe(
			"- Do vouched-in yazars inherit their kefil's moderation weight? — **ruled** · R1.2",
		);
	});

	it("splices between Solution and Out of scope, giving the four sections in order", () => {
		const body = composeSpec(AUTHORED, CLEARED_DECISIONS);
		expect(checkSections(body, SPEC_SECTIONS)).toBeNull();
		expect(body.indexOf("## Decisions")).toBeGreaterThan(body.indexOf("## Solution"));
		expect(body.indexOf("## Decisions")).toBeLessThan(body.indexOf("## Out of scope"));
	});

	it("reads every rendered line back to the row it came from", () => {
		const read = readDecisionsSection(composeSpec(AUTHORED, CLEARED_DECISIONS));
		expect(read).toEqual({_tag: "Decisions", value: CLEARED_DECISIONS});
	});

	it("recovers a ref that carries a space and a `#`, and text carrying its own em dash", () => {
		const row: DecisionRow = {
			ref: "#9301 R1.2",
			provenance: "ruled",
			text: "Weight is earned — never inherited · from a kefil.",
		};
		const read = readDecisionsSection(composeSpec(AUTHORED, [row]));
		expect(read).toEqual({_tag: "Decisions", value: [row]});
	});

	it("reports a hand-edited line rather than skipping it", () => {
		const body = composeSpec(AUTHORED, CLEARED_DECISIONS).replace(
			"- Do vouched",
			"- I decided this myself. Do vouched",
		);
		expect(readDecisionsSection(body.replace("— **ruled** · R1.2", ""))).toMatchObject({
			_tag: "Unparseable",
		});
	});
});

describe("the footer", () => {
	it("leads with `Filed by an agent` and carries the source and the spec digest", () => {
		expect(
			renderFooter({source: 9412, specDigest: "a1b2c3d4e5f6", timestamp: "2026-08-09T18:36:48Z"}),
		).toBe(
			"<sub>Filed by an agent · graduated from #9412 · spec a1b2c3d4e5f6 · 2026-08-09T18:36:48Z</sub>",
		);
	});

	it("sits after the sections and a blank line, newline-terminated", () => {
		const composed = withFooter(
			composeSpec(AUTHORED, CLEARED_DECISIONS),
			renderFooter({source: 9412, specDigest: "a1b2c3d4e5f6", timestamp: "2026-08-09T18:36:48Z"}),
		);
		expect(composed.endsWith("</sub>\n")).toBe(true);
		expect(composed).toContain("Weight decay on a clock — no decision yet.\n\n<sub>");
	});
});
