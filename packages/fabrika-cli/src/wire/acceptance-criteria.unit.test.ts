/**
 * The schema module's own tier: `emit`, and the three answers `read` may give.
 *
 * The assertions that carry the design are the drift cases. Each of them feeds a body a naive
 * reader would answer "no acceptance criteria" for, and asserts `Malformed` — because the failure
 * this module exists to remove is not a crash, it is a *plausible* answer. `expect(...).toBe(
 * "Malformed")` is the whole point; a test that only asserted "criteria is empty" would pass
 * against the defect.
 */
import {describe, expect, it} from "vitest";
import {
	type AcceptanceCriterion,
	emit,
	HEADING_TEXT,
	parseFields,
	read,
	renderCriteria,
} from "./acceptance-criteria.ts";

const body = (...lines: ReadonlyArray<string>): string => lines.join("\n");

const found = (source: string): ReadonlyArray<AcceptanceCriterion> => {
	const result = read(source);
	if (result._tag !== "Found") throw new Error(`expected Found, got ${result._tag}`);
	return result.value;
};

const CONFORMING = body(
	"**Stories:** 1, 2",
	"",
	"### What to build",
	"Stand up the group.",
	"",
	"### Acceptance criteria",
	"- [ ] the read is total",
	"- [x] the registry is the only place a format is registered",
	"",
	"### Notes",
	"Nothing else.",
);

describe("emit", () => {
	it("composes the heading and one checkbox line per criterion", () => {
		expect(
			emit([
				{text: "the read is total", checked: false},
				{text: "the registry is the seam", checked: true},
			]),
		).toBe("### Acceptance criteria\n\n- [ ] the read is total\n- [x] the registry is the seam\n");
	});

	it("round-trips: what it composes is what `read` finds", () => {
		const criteria: AcceptanceCriterion[] = [
			{text: "first", checked: true},
			{text: "second", checked: false},
			{text: "third with `backticks` and a #4942 ref", checked: false},
		];
		expect(found(emit([criteria[0]!, ...criteria.slice(1)]))).toEqual(criteria);
	});
});

describe("read — Found", () => {
	it("finds every criterion with its checked state, from a full sub-issue body", () => {
		expect(found(CONFORMING)).toEqual([
			{text: "the read is total", checked: false},
			{text: "the registry is the only place a format is registered", checked: true},
		]);
	});

	it("stops at the next heading rather than swallowing a later list", () => {
		expect(
			found(
				body("### Acceptance criteria", "- [ ] mine", "", "### Out of scope", "- [ ] not mine"),
			),
		).toEqual([{text: "mine", checked: false}]);
	});

	it("reads an uppercase [X] as checked — a tolerant read of a real drift that changes no meaning", () => {
		expect(found(body("### Acceptance criteria", "- [X] done"))).toEqual([
			{text: "done", checked: true},
		]);
	});
});

describe("read — Absent", () => {
	it("answers Absent for a body where nothing reaches for the block", () => {
		const result = read(body("### What to build", "Stand up the group.", "", "Some prose."));
		expect(result._tag).toBe("Absent");
	});

	it("answers Absent for a body that is only prose", () => {
		expect(read("Just a paragraph, no headings at all.")._tag).toBe("Absent");
	});
});

describe("read — Malformed: the drifts a naive reader answers `empty` for", () => {
	it("a drifted heading SPELLING is Malformed, never Found-with-nothing", () => {
		const result = read(body("### Acceptance Criteria:", "- [ ] one", "- [ ] two"));
		expect(result._tag).toBe("Malformed");
		if (result._tag !== "Malformed") return;
		expect(result.reason).toContain(HEADING_TEXT);
		expect(result.evidence).toContain("Acceptance Criteria:");
	});

	it("a typo inside the word is Malformed", () => {
		expect(read(body("### Acceptance critera", "- [ ] one"))._tag).toBe("Malformed");
	});

	it("a heading at the WRONG LEVEL is Malformed, and the reason names the level", () => {
		const result = read(body("## Acceptance criteria", "- [ ] one"));
		expect(result._tag).toBe("Malformed");
		if (result._tag !== "Malformed") return;
		expect(result.reason).toContain("heading level 2");
	});

	it("a level-4 heading is Malformed too — drift is drift in both directions", () => {
		expect(read(body("#### Acceptance criteria", "- [ ] one"))._tag).toBe("Malformed");
	});

	it("the conforming heading with NO checkbox item is Malformed, not an empty Found", () => {
		const result = read(
			body("### Acceptance criteria", "", "It should basically work.", "", "### Notes"),
		);
		expect(result._tag).toBe("Malformed");
		if (result._tag !== "Malformed") return;
		expect(result.reason).toContain("no");
	});

	it("a checkbox item with no text is Malformed rather than a silently dropped criterion", () => {
		const result = read(body("### Acceptance criteria", "- [ ] first", "- [ ]"));
		expect(result._tag).toBe("Malformed");
	});

	it("two conforming headings are Malformed — which one is the contract is undecidable", () => {
		const result = read(
			body("### Acceptance criteria", "- [ ] one", "", "### Acceptance criteria", "- [ ] two"),
		);
		expect(result._tag).toBe("Malformed");
		if (result._tag !== "Malformed") return;
		expect(result.reason).toContain("2");
	});

	it("no drift answer is ever Found, so no caller can read a drift as a zero-criteria contract", () => {
		const drifts = [
			body("### Acceptance Criteria", "- [ ] one"),
			body("## Acceptance criteria", "- [ ] one"),
			body("#### Acceptance criteria", "- [ ] one"),
			body("### Acceptance criterion", "- [ ] one"),
			body("### Acceptance criteria", "just prose"),
		];
		for (const drift of drifts) expect(read(drift)._tag).toBe("Malformed");
	});
});

describe("read — a fenced example is not the real block", () => {
	it("ignores a heading inside a code fence", () => {
		const result = read(
			body(
				"Here is the shape:",
				"",
				"```markdown",
				"### Acceptance criteria",
				"- [ ] an example, not the contract",
				"```",
				"",
				"That is all.",
			),
		);
		expect(result._tag).toBe("Absent");
	});

	it("reads the real block when a fenced example sits above it", () => {
		expect(
			found(
				body(
					"```markdown",
					"### Acceptance criteria",
					"- [ ] the example",
					"```",
					"",
					"### Acceptance criteria",
					"- [ ] the contract",
				),
			),
		).toEqual([{text: "the contract", checked: false}]);
	});
});

describe("parseFields", () => {
	it("takes one criterion per line, with the state marker optional", () => {
		expect(parseFields("first\n[x] second\n- [ ] third\n")).toEqual({
			_tag: "Fields",
			criteria: [
				{text: "first", checked: false},
				{text: "second", checked: true},
				{text: "third", checked: false},
			],
		});
	});

	it("refuses fields that hold no criterion — `emit` cannot compose an empty block", () => {
		expect(parseFields("\n   \n\n")._tag).toBe("Unusable");
	});

	it("refuses a state marker with no text rather than dropping the line", () => {
		const parsed = parseFields("first\n[x]\n");
		expect(parsed._tag).toBe("Unusable");
		if (parsed._tag !== "Unusable") return;
		expect(parsed.reason).toContain("line 2");
	});
});

describe("renderCriteria", () => {
	it("renders one `<state>\\t<text>` line per criterion", () => {
		expect(
			renderCriteria([
				{text: "a", checked: false},
				{text: "b", checked: true},
			]),
		).toEqual(["open\ta", "checked\tb"]);
	});
});
