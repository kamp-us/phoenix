import {describe, expect, it} from "vitest";
import {readReport} from "./report.ts";

describe("readReport", () => {
	it("reads the section's text, subheadings included, up to the next level-2 heading", () => {
		const body = [
			"does a thing",
			"",
			"## Report",
			"",
			"### Audit scope",
			"",
			"Every caller of `refocus()`.",
			"",
			"## Deviations",
			"",
			"None.",
		].join("\n");
		expect(readReport(body)).toEqual({
			state: "found",
			text: "### Audit scope\n\nEvery caller of `refocus()`.",
			line: 3,
		});
	});

	it("leaves the body's closing-keyword line out of a report that is the last section", () => {
		const read = readReport("## Report\n\nNo live overlap with #12.\n\nFixes #8924\n");
		expect(read).toMatchObject({state: "found", text: "No live overlap with #12."});
	});

	it("reads absent when no heading reaches for the section, an author's own headings included", () => {
		const read = readReport("## Test report\n\nall green\n\n## Reporting\n\nnone\n");
		expect(read.state).toBe("absent");
	});

	it("does not take a fenced example of the heading for the section", () => {
		expect(readReport("```md\n## Report\n\nexample\n```\n").state).toBe("absent");
	});

	it.each([
		["a drifted level", "### Report\n\nscope: all\n", 'line 1: "### Report"'],
		["a drifted spelling", "## report\n\nscope: all\n", 'line 1: "## report"'],
		["an empty section", "## Report\n\n## Deviations\n\nNone.\n", "its section is empty"],
		["a section holding only the closing line", "## Report\n\nFixes #1\n", "its section is empty"],
		["two headings", "## Report\n\na\n\n## Report\n\nb\n", "2 report headings"],
	])("reads malformed for %s and names what drifted", (_, body, evidence) => {
		const read = readReport(body);
		expect(read.state).toBe("malformed");
		expect(read.state === "malformed" ? read.reason : "").toContain(evidence);
	});
});
