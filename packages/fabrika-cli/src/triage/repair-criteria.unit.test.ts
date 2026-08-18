import {describe, expect, it} from "vitest";
import {read} from "../wire/acceptance-criteria.ts";
import {renderMarker, SUMMARY_LINE} from "./enrich.ts";
import {legacyPreserved} from "./enrich-legacy.ts";
import {planRepair, splitAuthored} from "./repair-criteria.ts";

const ITEMS = "- [ ] The verb repairs one issue\n- [x] The reader stays at level 3";

/** A rewrite-mode enriched body whose PRESERVED original also carries a `##` heading. */
const preservedBlock = `<details>\n${SUMMARY_LINE.rewrite}\n\n## Summary\n\nDrifted.\n\n## Acceptance criteria\n\n- [ ] the historical record\n\n</details>\n`;
const enveloped = (authored: string, issue = 5744): string =>
	`${authored}\n\n---\n\n${renderMarker(issue, "rewrite")}\n${preservedBlock}`;

const plan = (body: string) => planRepair(body, 5744, legacyPreserved);

describe("planRepair — the mechanical repair", () => {
	it("rewrites a level-2 heading to level 3 and changes nothing else", () => {
		const body = enveloped(`Intro.\n\n## Acceptance criteria\n\n${ITEMS}`);
		const result = plan(body);
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toBe(enveloped(`Intro.\n\n### Acceptance criteria\n\n${ITEMS}`));
		expect(result.repairs).toEqual([{_tag: "HeadingLevel", line: 3, fromLevel: 2}]);
	});

	it("leaves the preserved original's `##` heading and the marker byte for byte", () => {
		const body = enveloped(`## Acceptance criteria\n\n${ITEMS}`);
		const result = plan(body);
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toContain(renderMarker(5744, "rewrite"));
		expect(result.body).toContain(preservedBlock);
		expect(result.body.endsWith(preservedBlock)).toBe(true);
	});

	it("round-trips through `read`: same criteria texts and checked states as the drifted body", () => {
		const body = enveloped(`## Acceptance criteria\n\n${ITEMS}`);
		const result = plan(body);
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		const back = read(result.body);
		expect(back._tag).toBe("Found");
		if (back._tag !== "Found") return;
		expect(back.value.map(({text, checked}) => [text, checked])).toEqual([
			["The verb repairs one issue", false],
			["The reader stays at level 3", true],
		]);
		expect(back.value).toEqual(result.criteria);
	});

	it("repairs a level-4 drift too — the defect is the level, whatever the level is", () => {
		const result = plan(enveloped(`#### Acceptance criteria\n\n${ITEMS}`));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.repairs).toEqual([{_tag: "HeadingLevel", line: 1, fromLevel: 4}]);
	});

	it("answers AlreadyConforming on a level-3 body, touching nothing", () => {
		expect(plan(enveloped(`### Acceptance criteria\n\n${ITEMS}`))._tag).toBe("AlreadyConforming");
	});

	it("answers NoBlock on a body with no acceptance-criteria heading at all", () => {
		expect(plan("## Summary\n\nNothing here reaches for the block.")._tag).toBe("NoBlock");
	});

	it("refuses drifted TEXT — rewriting it would be inventing a contract", () => {
		const result = plan(enveloped(`## Acceptance criterias\n\n${ITEMS}`));
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain('heading text "Acceptance criterias"');
	});

	it("answers NoBlock when the only heading lives inside the preserved original (#5852)", () => {
		// The reader no longer counts a `<details>` appendix, so this body is `Absent` rather than
		// the `Malformed` that used to have to land on a refusal here.
		expect(plan(enveloped("Just prose above the marker, no heading."))._tag).toBe("NoBlock");
	});

	it("refuses two drifted headings in the authored region as undecidable", () => {
		const result = plan(
			enveloped(`## Acceptance criteria\n\n${ITEMS}\n\n## Acceptance criteria\n\n- [ ] again`),
		);
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain("undecidable");
	});

	it("refuses a drifted heading whose section holds no checkbox item — pre-verified, never written", () => {
		const result = plan(enveloped("## Acceptance criteria\n\nProse, no checkboxes."));
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain("does not make the block readable");
	});

	it("repairs a bare body with no envelope at all — authored end to end", () => {
		const result = plan(`## Acceptance criteria\n\n${ITEMS}`);
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toBe(`### Acceptance criteria\n\n${ITEMS}`);
	});
});

describe("planRepair — the bullet conversion (#6001)", () => {
	const BULLETS = "- The verb repairs one issue\n- The reader stays at level 3";
	const CHECKED = "- [ ] The verb repairs one issue\n- [ ] The reader stays at level 3";

	it("rewrites plain bullets under a conforming heading to unchecked checkboxes", () => {
		const result = plan(enveloped(`Intro.\n\n### Acceptance criteria\n\n${BULLETS}`));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toBe(enveloped(`Intro.\n\n### Acceptance criteria\n\n${CHECKED}`));
		expect(result.repairs).toEqual([{_tag: "BulletItems", lines: [5, 6]}]);
	});

	it("leaves each item's text byte for byte — only the marker is added", () => {
		const result = plan(enveloped("### Acceptance criteria\n\n*   `emit` stays  spaced   oddly"));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toContain("*   [ ] `emit` stays  spaced   oddly");
	});

	it("folds a wrapped bullet's continuation line into the one criterion, unrewritten", () => {
		const result = plan(
			enveloped("### Acceptance criteria\n\n- The verb repairs\n  one wrapped criterion"),
		);
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toContain("- [ ] The verb repairs\n  one wrapped criterion");
		expect(result.criteria.map(({text}) => text)).toEqual([
			"The verb repairs one wrapped criterion",
		]);
	});

	it("repairs a level drift and its bullets in one plan, heading first", () => {
		const result = plan(enveloped(`## Acceptance criteria\n\n${BULLETS}`));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toBe(enveloped(`### Acceptance criteria\n\n${CHECKED}`));
		expect(result.repairs.map(({_tag}) => _tag)).toEqual(["HeadingLevel", "BulletItems"]);
	});

	it("round-trips through `read`: every bullet becomes an open criterion, none checked", () => {
		const result = plan(enveloped(`### Acceptance criteria\n\n${BULLETS}`));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		const back = read(result.body);
		expect(back._tag).toBe("Found");
		if (back._tag !== "Found") return;
		expect(back.value).toEqual([
			{text: "The verb repairs one issue", checked: false},
			{text: "The reader stays at level 3", checked: false},
		]);
		expect(back.value).toEqual(result.criteria);
	});

	it("leaves a MIXED block alone: it already reads, so promoting its bullets would add criteria", () => {
		// The reader answers `Found` over the checkbox items and drops the bullet, so there is a
		// contract in force — widening it is a content decision, not a shape rewrite.
		expect(plan(enveloped("### Acceptance criteria\n\n- [ ] a real one\n\n- a bullet"))._tag).toBe(
			"AlreadyConforming",
		);
	});

	it("repairs only the heading when the level fix alone makes a mixed block read", () => {
		// The block states a criterion the moment it reads, so the bullet beside it is never promoted.
		const result = plan(enveloped("## Acceptance criteria\n\n- a bullet\n- [ ] a real one"));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.repairs.map(({_tag}) => _tag)).toEqual(["HeadingLevel"]);
		expect(result.body).toContain("- a bullet\n- [ ] a real one");
	});

	it("refuses a mixed block that reaches the conversion — a checkbox means the block already speaks", () => {
		const result = plan(enveloped("### Acceptance criteria\n\n- a bullet\n- [ ]   "));
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain("already a checkbox item");
	});

	it("refuses a prose paragraph standing between the list's items", () => {
		const result = plan(
			enveloped("### Acceptance criteria\n\n- one item\n\nSome prose.\n\n- another item"),
		);
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain("is not one");
		expect(result.reason).toContain("does not make the block readable");
	});

	it("leaves a preamble sentence above the list alone — the window is the list itself", () => {
		const result = plan(enveloped(`### Acceptance criteria\n\nThe PR must:\n\n${BULLETS}`));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body).toContain(`The PR must:\n\n${CHECKED}`);
	});

	it("refuses an empty list item rather than composing a criterion with no text", () => {
		const result = plan(enveloped("### Acceptance criteria\n\n- one real item\n-   "));
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain("carrying no text");
	});

	it("refuses a non-bullet block in the list — an ordered item the reader would drop", () => {
		const result = plan(
			enveloped("### Acceptance criteria\n\n- one item\n\n1. another\n\n- a third"),
		);
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain('is not one ("1. another")');
	});

	it("still refuses a drifted heading TEXT over plain bullets — the widening swallows nothing", () => {
		const result = plan(enveloped(`## Acceptance criterias\n\n${BULLETS}`));
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain('heading text "Acceptance criterias"');
	});

	it("leaves the preserved original's bullets untouched — the appendix is not the contract", () => {
		const result = plan(enveloped(`### Acceptance criteria\n\n${BULLETS}`));
		expect(result._tag).toBe("Repaired");
		if (result._tag !== "Repaired") return;
		expect(result.body.endsWith(preservedBlock)).toBe(true);
	});
});

describe("splitAuthored — the boundary is the marker `triage enrich` writes", () => {
	it("splits at this issue's marker, marker included in the preserved half", () => {
		const body = enveloped("authored");
		const {authored, preserved} = splitAuthored(body, 5744, legacyPreserved);
		expect(authored + preserved).toBe(body);
		expect(preserved.startsWith(renderMarker(5744, "rewrite"))).toBe(true);
	});

	it("reads a marker bound to ANOTHER issue as authored end to end — a paste, not an envelope", () => {
		const body = enveloped("authored", 4290);
		const {authored, preserved} = splitAuthored(body, 5744, legacyPreserved);
		expect(authored).toBe(body);
		expect(preserved).toBe("");
	});

	it("recognises a pre-marker v1 envelope through the injected legacy recogniser", () => {
		const body = `authored\n\n---\n\n${preservedBlock}`;
		const {authored, preserved} = splitAuthored(body, 5744, legacyPreserved);
		expect(preserved).toBe(preservedBlock);
		expect(authored + preserved).toBe(body);
	});
});
