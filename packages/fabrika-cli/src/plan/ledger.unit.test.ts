import {describe, expect, it} from "vitest";
import {
	fieldLines,
	readChildStories,
	readContainment,
	readEpicStories,
	sectionCount,
	unfencedLines,
} from "./ledger.ts";

describe("fence awareness", () => {
	/**
	 * v1 had no fence awareness anywhere, so a documentation example inside a fence set a real child's
	 * data. Remove the fence skip in `unfencedLines` and every assertion here goes red.
	 */
	it("drops fenced lines, so a documented example is not a declaration", () => {
		const body = ["**Stories:** 1", "", "```", "**Stories:** 9", "```", ""].join("\n");
		expect(fieldLines(body, "Stories")).toEqual(["1"]);
	});

	it("counts a heading inside a fence as no section at all", () => {
		const body = ["## Dependencies", "", "```md", "## Dependencies", "```", ""].join("\n");
		expect(sectionCount(body, "Dependencies")).toBe(1);
	});

	it("keeps the lines outside the fence, in order", () => {
		expect(unfencedLines("a\n```\nb\n```\nc").map((l) => l.text)).toEqual(["a", "c"]);
	});
});

describe("sectionCount", () => {
	it("is level-indifferent — a ledger reads the same under ## or ###", () => {
		expect(sectionCount("### Dependencies\n", "Dependencies")).toBe(1);
	});

	it("counts a duplicate, which is what the caller seats the 4 on", () => {
		expect(sectionCount("## Dependencies\n\n### Dependencies\n", "Dependencies")).toBe(2);
	});
});

describe("readEpicStories", () => {
	it("reads the items' own leading integers, never their positions", () => {
		const body = "### User stories\n\n1. one\n2. two\n3. three\n";
		expect(readEpicStories(body)).toEqual({_tag: "Stories", ids: [1, 2, 3]});
	});

	/**
	 * v1 read list *positions* as ids, so a mis-numbered list silently renumbered every story and the
	 * coverage defects pointed at the wrong ones. Drop the contiguity check and this reads `[1,3]` as
	 * a clean two-story list.
	 */
	it("refuses a gap", () => {
		const body = "### User stories\n\n1. one\n3. three\n";
		expect(readEpicStories(body)).toEqual({_tag: "MisNumbered", ids: [1, 3]});
	});

	it("refuses a repeat", () => {
		expect(readEpicStories("### User stories\n\n1. one\n1. one again\n")._tag).toBe("MisNumbered");
	});

	it("reads an absent section as zero stories, not as a refusal", () => {
		expect(readEpicStories("nothing here")).toEqual({_tag: "Stories", ids: []});
	});

	it("reads an empty list as zero stories — MISSING_STORIES_SECTION's only input", () => {
		expect(readEpicStories("### User stories\n\nnone yet\n")).toEqual({_tag: "Stories", ids: []});
	});

	it("stops at the next heading of the same or shallower level", () => {
		const body = "### User stories\n\n1. one\n\n### Other\n\n2. not a story\n";
		expect(readEpicStories(body)).toEqual({_tag: "Stories", ids: [1]});
	});
});

describe("readChildStories", () => {
	it("reads a conforming list", () => {
		expect(readChildStories("1, 2")).toEqual({_tag: "Ids", ids: [1, 2]});
	});

	it("reads `none` as the empty list", () => {
		expect(readChildStories("none")).toEqual({_tag: "Ids", ids: []});
	});

	it("reads no line at all as absent", () => {
		expect(readChildStories(undefined)).toEqual({_tag: "Absent"});
	});

	/**
	 * v1 harvested every bare integer anywhere in the value, so this line silently claimed story 4021.
	 * Widen the value regex and the assertion below flips to `{_tag:"Ids"}`.
	 */
	it("reads a non-conforming value as absent, and carries it for the detail", () => {
		expect(readChildStories("1, 3 (see #4021)")).toEqual({
			_tag: "NonConforming",
			value: "1, 3 (see #4021)",
		});
	});
});

describe("readContainment", () => {
	it.each([
		["flag", "flag"],
		["exempt", "exempt"],
		["none", "none"],
		["flag (behind kampus-plan-gate)", "flag"],
	])("reads the leading keyword of %s", (value, expected) => {
		expect(readContainment(value)).toBe(expected);
	});

	it("reads anything off the closed set as unset", () => {
		expect(readContainment("probably")).toBeNull();
		expect(readContainment(undefined)).toBeNull();
	});
});
