import {describe, expect, it} from "vitest";
import {parseFields, read} from "./report.ts";

describe("read", () => {
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
		expect(read(body)).toEqual({
			_tag: "Found",
			value: {text: "### Audit scope\n\nEvery caller of `refocus()`.", line: 3},
		});
	});

	it("leaves the body's closing-keyword line out of a report that is the last section", () => {
		const result = read("## Report\n\nNo live overlap with #12.\n\nFixes #8924\n");
		expect(result).toMatchObject({_tag: "Found", value: {text: "No live overlap with #12."}});
	});

	it("reads absent when no heading reaches for the section, an author's own headings included", () => {
		expect(read("## Test report\n\nall green\n\n## Reporting\n\nnone\n")._tag).toBe("Absent");
	});

	it.each([
		[
			"beside the section",
			"## Summary, Report\n\nwhat changed\n\n## Report\n\nAudit scope: all callers.\n",
			5,
		],
		[
			"nested inside it",
			"## Report\n\nAudit scope: all callers.\n\n### Notes, Report\n\nnone\n",
			1,
		],
	])("reads found past a heading carrying Report as one comma-separated part, %s", (_, body, line) => {
		const result = read(body);
		expect(result).toMatchObject({_tag: "Found", value: {line}});
		expect(result._tag === "Found" ? result.value.text : "").toContain("Audit scope: all callers.");
	});

	it("does not take a fenced example of the heading for the section", () => {
		expect(read("```md\n## Report\n\nexample\n```\n")._tag).toBe("Absent");
	});

	it.each([
		["a drifted level", "### Report\n\nscope: all\n", 'line 1: "### Report"'],
		["a drifted spelling", "## report\n\nscope: all\n", 'line 1: "## report"'],
		["an empty section", "## Report\n\n## Deviations\n\nNone.\n", "its section is empty"],
		["a section holding only the closing line", "## Report\n\nFixes #1\n", "its section is empty"],
		["two headings", "## Report\n\na\n\n## Report\n\nb\n", "2 report headings"],
	])("reads malformed for %s and names what drifted", (_, body, named) => {
		const result = read(body);
		expect(result._tag).toBe("Malformed");
		expect(result._tag === "Malformed" ? `${result.reason} — ${result.evidence}` : "").toContain(
			named,
		);
	});
});

describe("parseFields", () => {
	it.each([
		["a blank report", "  \n\n", "the report is empty"],
		["a report carrying a level-2 heading", "scope: all\n\n## Notes\n\nmore\n", "read back whole"],
		["a report ending on a closing line", "scope: all\n\nFixes #1\n", "read back whole"],
	])("refuses %s, which its own reader would not return", (_, fields, reason) => {
		const parsed = parseFields(fields);
		expect(parsed._tag).toBe("Unusable");
		expect(parsed._tag === "Unusable" ? parsed.reason : "").toContain(reason);
	});
});
