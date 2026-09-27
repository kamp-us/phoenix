import {describe, expect, it} from "vitest";
import {SHIPPED_CONTAINMENT_VOCABULARY} from "../config/keys/containment-vocabulary.ts";
import {type AdoptionInput, judgeAdoption, parseStoriesFlag} from "./adoption.ts";
import {BAD_SECTIONS, OFF_VOCABULARY} from "./codes.ts";

const CRITERIA = "### Acceptance criteria\n- [ ] it works\n";

const input = (overrides: Partial<AdoptionInput> = {}): AdoptionInput => ({
	body: CRITERIA,
	labels: ["type:bug", "p1", "status:triaged", "ready-for:agent"],
	assignees: [],
	cycleDoc: "absent",
	vocabulary: SHIPPED_CONTAINMENT_VOCABULARY,
	stories: {_tag: "Ids", ids: [1]},
	containment: null,
	...overrides,
});

describe("judgeAdoption", () => {
	it("owes a Stories line the body does not declare", () => {
		expect(judgeAdoption(input())).toEqual({
			_tag: "Adoptable",
			fields: ["**Stories:** 1"],
			stories: [1],
			containment: null,
		});
	});

	it("owes nothing when the body already declares the same stories, in any order", () => {
		const judged = judgeAdoption(
			input({body: `**Stories:** 2, 1\n\n${CRITERIA}`, stories: {_tag: "Ids", ids: [1, 2]}}),
		);
		expect(judged).toMatchObject({_tag: "Adoptable", fields: [], stories: [2, 1]});
	});

	it("renders an empty story list as none", () => {
		expect(judgeAdoption(input({stories: {_tag: "Ids", ids: []}}))).toMatchObject({
			fields: ["**Stories:** none"],
		});
	});

	it.each([
		["a non-conforming Stories line", `**Stories:** 1 (see the other ticket)\n\n${CRITERIA}`],
		["a Stories line declared twice", `**Stories:** 1\n**Stories:** 1\n\n${CRITERIA}`],
		["no acceptance criteria", "Just a report.\n"],
	])("refuses %s on 4 — it never rewrites", (_, body) => {
		expect(judgeAdoption(input({body}))).toMatchObject({_tag: "Refused", code: BAD_SECTIONS});
	});

	it.each([
		["a type:epic", ["type:epic", "p1", "status:triaged"]],
		["an untriaged issue", ["type:bug", "p1", "status:needs-triage"]],
		["an issue missing a priority", ["type:bug", "status:triaged"]],
		["a held issue with nobody assigned", ["type:bug", "p1", "status:triaged", "ready-for:human"]],
	])("refuses %s on 10", (_, labels) => {
		expect(judgeAdoption(input({labels}))).toMatchObject({_tag: "Refused", code: OFF_VOCABULARY});
	});

	it("ignores containment entirely while the cycle doc is not present", () => {
		expect(
			judgeAdoption(input({labels: ["type:feature", "p1", "status:triaged"], containment: "x"})),
		).toMatchObject({_tag: "Adoptable", containment: null, fields: ["**Stories:** 1"]});
	});

	it("keeps a declared legal containment and refuses a differing flag", () => {
		const body = `**Stories:** 1\n**Containment:** exempt\n\n${CRITERIA}`;
		const labels = ["type:feature", "p1", "status:triaged"];
		expect(judgeAdoption(input({body, labels, cycleDoc: "present"}))).toMatchObject({
			_tag: "Adoptable",
			fields: [],
			containment: "exempt",
		});
		expect(
			judgeAdoption(input({body, labels, cycleDoc: "present", containment: "flag"})),
		).toMatchObject({_tag: "Refused", code: BAD_SECTIONS});
	});

	it("refuses a --containment off the vocabulary on 10", () => {
		expect(
			judgeAdoption(
				input({
					labels: ["type:feature", "p1", "status:triaged"],
					cycleDoc: "present",
					containment: "maybe",
				}),
			),
		).toMatchObject({_tag: "Refused", code: OFF_VOCABULARY});
	});
});

describe("parseStoriesFlag", () => {
	it("reads the gate's grammar and keeps a non-conforming value for the refusal", () => {
		expect(parseStoriesFlag("1, 3")).toEqual({_tag: "Ids", ids: [1, 3]});
		expect(parseStoriesFlag("none")).toEqual({_tag: "Ids", ids: []});
		expect(parseStoriesFlag(" 1 (see #9) ")).toEqual({_tag: "NonConforming", value: "1 (see #9)"});
	});
});
