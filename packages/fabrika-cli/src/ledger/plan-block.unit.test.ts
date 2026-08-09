import {describe, expect, it} from "vitest";
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

	it("does not judge content — a TBD section passes", () => {
		expect(
			checkPlanBlock(planBlock().replace("Something true about this section.", "TBD")),
		).toMatchObject({_tag: "Ok"});
	});
});
