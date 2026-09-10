import {describe, expect, it} from "vitest";
import {read as readAcceptanceCriteria} from "../wire/acceptance-criteria.ts";
import {planBlock} from "./fixtures.test-support.ts";
import {checkPlanBlock, PLAN_SECTIONS} from "./plan-block.ts";

describe("checkPlanBlock", () => {
	it("passes a block carrying every section once, in order, with contiguous stories", () => {
		expect(checkPlanBlock(planBlock())).toEqual({
			_tag: "Ok",
			sections: PLAN_SECTIONS.length,
			stories: [1, 2],
		});
	});

	it("names the missing sections rather than the first one", () => {
		const checked = checkPlanBlock(planBlock({drop: "Approach"}));
		expect(checked).toMatchObject({_tag: "Bad"});
		expect(checked).toMatchObject({
			reason: expect.stringContaining("missing section(s): Approach"),
		});
	});

	it("refuses a block that does not open with the plan heading", () => {
		const checked = checkPlanBlock(`## Plan\n\n${planBlock()}`);
		expect(checked).toMatchObject({
			reason: 'the plan block does not open with "## Plan (plan-epic)".',
		});
	});

	it("refuses a duplicated section — two of one has no single meaning", () => {
		const checked = checkPlanBlock(`${planBlock()}\n### Approach\n\nagain\n`);
		expect(checked).toMatchObject({
			reason: expect.stringContaining('carries 2 "Approach" sections'),
		});
	});

	it("refuses sections that appear out of order", () => {
		const reordered = planBlock()
			.replace("### Approach\n\nSomething true about this section.\n\n", "")
			.replace("### Summary", "### Approach\n\nSomething true about this section.\n\n### Summary");
		expect(checkPlanBlock(reordered)).toMatchObject({
			reason: expect.stringContaining("out of order"),
		});
	});

	it("refuses a mis-numbered story list", () => {
		const checked = checkPlanBlock(planBlock({stories: "1. one\n2. two\n4. four"}));
		expect(checked).toMatchObject({
			reason:
				"user stories are numbered 1, 2, 4 — a story list must run from 1 with no gaps or repeats.",
		});
	});

	/**
	 * The trap the refusal is really for: `readEpicStories` collects ids only from ordered-list rows, so
	 * a section full of bullets parses as zero stories while looking complete to its author, and the
	 * gate's floor then reds `MISSING_STORIES_SECTION` over the whole epic.
	 */
	it("refuses a story section written as bullets — it parses as zero stories", () => {
		const checked = checkPlanBlock(planBlock({stories: "- As a moderator, I want a queue."}));
		expect(checked).toMatchObject({
			reason: expect.stringContaining("the plan declares zero user stories"),
		});
	});

	it("refuses an `S<n>`-labelled story list for the same reason", () => {
		expect(checkPlanBlock(planBlock({stories: "S1. one\nS2. two"}))).toMatchObject({
			reason: expect.stringContaining("zero user stories"),
		});
	});

	it("names `Acceptance criteria` when the plan omits it — the epic tail's contract", () => {
		const checked = checkPlanBlock(planBlock({drop: "Acceptance criteria"}));
		expect(checked).toMatchObject({
			reason: expect.stringContaining("missing section(s): Acceptance criteria"),
		});
	});

	it("refuses criteria written as prose — the wire reader would find none", () => {
		const checked = checkPlanBlock(
			planBlock({criteria: "The tail ships when every child is wired."}),
		);
		expect(checked).toMatchObject({
			reason: expect.stringContaining("acceptance criteria read as"),
		});
	});

	it("refuses a blank line under the criteria heading — the child body's byte rule", () => {
		const checked = checkPlanBlock(
			planBlock().replace("### Acceptance criteria\n- [ ]", "### Acceptance criteria\n\n- [ ]"),
		);
		expect(checked).toMatchObject({
			reason: expect.stringContaining("is followed by a blank line"),
		});
	});

	it("passes criteria written as checkbox rows under their heading", () => {
		expect(checkPlanBlock(planBlock({criteria: "- [ ] one\n- [ ] two"}))).toMatchObject({
			_tag: "Ok",
		});
	});

	it("does not judge content — a TBD section passes", () => {
		expect(
			checkPlanBlock(planBlock().replace("Something true about this section.", "TBD")),
		).toMatchObject({_tag: "Ok"});
	});
});

/**
 * The whole point of the section: what `ledger write` splices must be what `review criteria <epic>`
 * reads back. Checking the block alone would not catch the two ways the *spliced body* loses it —
 * a `## Dependencies` block below it, and the enriched original's own buried legacy heading.
 */
describe("the staged block survives the splice into an epic body", () => {
	it("reads back Found, and the enriched appendix's buried block is not the contract", () => {
		const block = planBlock({criteria: "- [ ] one\n- [ ] two"});
		expect(checkPlanBlock(block)).toMatchObject({_tag: "Ok"});

		const body = [
			"## Pitch\n\nwords\n",
			block,
			"## Dependencies\n\n- phase 1: #4301\n",
			"<!-- fabrika:enriched issue=4300 mode=rewrite -->",
			"<details>",
			"<summary>Original report (verbatim)</summary>",
			"",
			"### Acceptance criteria",
			"- [ ] a buried legacy row",
			"",
			"</details>",
		].join("\n");

		const found = readAcceptanceCriteria(body);
		expect(found._tag).toBe("Found");
		expect(found._tag === "Found" ? found.value.map((row) => row.text) : []).toEqual([
			"one",
			"two",
		]);
	});
});
