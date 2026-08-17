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
		expect(result.fromLevel).toBe(2);
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
		expect(result.fromLevel).toBe(4);
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

	it("refuses when the only drift lives inside the preserved original — never a no-op", () => {
		const result = plan(enveloped("Just prose above the marker, no heading."));
		expect(result._tag).toBe("Refused");
		if (result._tag !== "Refused") return;
		expect(result.reason).toContain("authored region");
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
