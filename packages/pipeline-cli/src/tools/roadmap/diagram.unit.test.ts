/**
 * Pure-core tests for `roadmap diagram` (#3870): the `## Dependencies` table parse, the
 * arc/campaign → state-styled node mapping, endpoint→node binding (a name resolves to its
 * row; anything else becomes an `external` node), and the deterministic node/edge ordering the
 * follow-up roadmap-guard drift check relies on. No IO — the ROADMAP.md read lives in `command.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {parseRoadmap} from "../roadmap-guard/roadmap-guard.ts";
import {generateDiagram, parseDependencies} from "./diagram.ts";

const roadmapMd =
	"## Arcs\n\n| Arc | Milestone | State |\n|--|--|--|\n" +
	"| Four Pillars | #17 | active |\n| Geçit | #24 | queued |\n| Atölye | #26 | done |\n\n" +
	"## Campaigns\n\n| Campaign | Milestone | State |\n|--|--|--|\n" +
	"| Flag Graduation | #39 | active |\n| Writing-Craft Import | #30 | done |\n\n" +
	"## Dependencies\n\n| Blocker | Blocks | Why |\n|--|--|--|\n" +
	"| #3642 | Flag Graduation | anka-ops cutover before the drain |\n" +
	"| ADR 0202 | Triage rubric | doctrine precedes the rubric |\n";

describe("parseDependencies", () => {
	it("reads Blocker/Blocks/Why rows from the ## Dependencies table", () => {
		expect(parseDependencies(roadmapMd)).toEqual([
			{blocker: "#3642", blocks: "Flag Graduation", why: "anka-ops cutover before the drain"},
			{blocker: "ADR 0202", blocks: "Triage rubric", why: "doctrine precedes the rubric"},
		]);
	});

	it("returns [] when there is no ## Dependencies section", () => {
		expect(parseDependencies("## Arcs\n\n| Arc | Milestone | State |\n|--|--|--|\n")).toEqual([]);
	});

	it("drops a row missing an endpoint (a stray table artifact), never a phantom edge", () => {
		const md = "## Dependencies\n\n| Blocker | Blocks | Why |\n|--|--|--|\n| #1 |  | no target |\n";
		expect(parseDependencies(md)).toEqual([]);
	});
});

describe("generateDiagram", () => {
	const {arcs, campaigns} = parseRoadmap(roadmapMd);
	const out = generateDiagram(arcs, campaigns, parseDependencies(roadmapMd));

	it("emits a fenced mermaid flowchart block", () => {
		expect(out.startsWith("```mermaid\n")).toBe(true);
		expect(out.endsWith("\n```")).toBe(true);
		expect(out).toContain("flowchart TD");
		expect(out).not.toMatch(/\n$/); // no trailing newline — the command adds one via Console.log
	});

	it("styles each arc/campaign node by its lifecycle state", () => {
		expect(out).toContain('arc_four_pillars["Four Pillars"]:::active');
		expect(out).toContain('arc_ge_it["Geçit"]:::queued');
		expect(out).toContain('arc_at_lye["Atölye"]:::done');
		expect(out).toContain('camp_flag_graduation["Flag Graduation"]:::active');
		expect(out).toContain('camp_writing_craft_import["Writing-Craft Import"]:::done');
	});

	it("binds an edge endpoint that names a row to that row's node", () => {
		// #3642 (external) → Flag Graduation (the campaign node, not a fresh external)
		expect(out).toContain("ext_3642 --> camp_flag_graduation");
		expect(out).toContain('ext_3642["#3642"]:::external');
	});

	it("renders a non-row endpoint as an external node (both ends here)", () => {
		expect(out).toContain('ext_adr_0202["ADR 0202"]:::external');
		expect(out).toContain('ext_triage_rubric["Triage rubric"]:::external');
		expect(out).toContain("ext_adr_0202 --> ext_triage_rubric");
	});

	it("emits the classDef styling for every state", () => {
		for (const s of ["active", "queued", "done", "external"]) {
			expect(out).toContain(`classDef ${s} `);
		}
	});

	it("is deterministic: node order is arcs, then campaigns, then externals in first-appearance order", () => {
		const idx = (needle: string) => out.indexOf(needle);
		expect(idx("arc_four_pillars")).toBeLessThan(idx("camp_flag_graduation"));
		expect(idx("camp_writing_craft_import")).toBeLessThan(idx('ext_3642["#3642"]'));
		// external nodes appear in the order their endpoints are first seen across the dep rows
		expect(idx('ext_3642["#3642"]')).toBeLessThan(idx('ext_adr_0202["ADR 0202"]'));
		expect(idx('ext_adr_0202["ADR 0202"]')).toBeLessThan(idx('ext_triage_rubric["Triage rubric"]'));
		// same input ⇒ byte-identical output
		expect(generateDiagram(arcs, campaigns, parseDependencies(roadmapMd))).toBe(out);
	});
});
