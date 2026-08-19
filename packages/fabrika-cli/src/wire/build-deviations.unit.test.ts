import {describe, expect, it} from "vitest";
import {emit, parseFields, read} from "./build-deviations.ts";

const entry =
	"- **Scope narrowing** — **Said:** both surfaces. **Did:** the reader only. **Why:** the writer is the next child's range. **Disposition:** stated here.";

describe("read", () => {
	it("finds the issue and the entries under the section", () => {
		const result = read(`build-deviations: #5828\n\n## Deviations\n\n${entry}\n`);
		expect(result).toMatchObject({
			_tag: "Found",
			value: {issue: 5828, disclosure: {_tag: "Entries"}},
		});
	});

	it("finds the None. claim as NoneDeclared, not as an empty list", () => {
		expect(read("build-deviations: #5828\n\n## Deviations\n\nNone.\n")).toEqual({
			_tag: "Found",
			value: {issue: 5828, disclosure: {_tag: "NoneDeclared"}},
		});
	});

	it("answers Absent for a comment that never reaches for the format", () => {
		expect(read("Landed on the assembly branch — over to the next child.\n")._tag).toBe("Absent");
	});

	it("answers Malformed when the marker names no issue", () => {
		const result = read("build-deviations:\n\n## Deviations\n\nNone.\n");
		expect(result._tag).toBe("Malformed");
	});

	it("answers Malformed, not Absent, when the marker promises a section that never follows", () => {
		const result = read("build-deviations: #5828\n\nEverything went to plan.\n");
		expect(result._tag).toBe("Malformed");
	});

	it("passes the section's own drift through as Malformed", () => {
		const result = read("build-deviations: #5828\n\n### Deviations\n\nNone.\n");
		expect(result._tag).toBe("Malformed");
	});

	it("does not read a marker quoted further down the body", () => {
		expect(
			read(`A child would post:\n\nbuild-deviations: #5828\n\n## Deviations\n\nNone.\n`)._tag,
		).toBe("Absent");
	});
});

describe("emit", () => {
	it("round-trips the None. claim through read", () => {
		const composed = emit({issue: 5828, disclosure: {_tag: "NoneDeclared"}});
		expect(read(composed)).toMatchObject({
			_tag: "Found",
			value: {issue: 5828, disclosure: {_tag: "NoneDeclared"}},
		});
	});
});

describe("parseFields", () => {
	it("takes the issue line, then the section's fields as the deviations format takes them", () => {
		const parsed = parseFields("issue: 5828\nNone.\n");
		expect(parsed).toEqual({
			_tag: "Fields",
			value: {issue: 5828, disclosure: {_tag: "NoneDeclared"}},
		});
	});

	it("tolerates a leading # on the issue, which is how a human writes it", () => {
		expect(parseFields("issue: #5828\nNone.\n")._tag).toBe("Fields");
	});

	it.each([
		["no issue line", "None.\n"],
		["an issue that is not a number", "issue: the editor one\nNone.\n"],
		["an entry line missing a field", "issue: 5828\n1\tsaid\tdid\twhy\n"],
	])("refuses %s", (_case, fields) => {
		expect(parseFields(fields)._tag).toBe("Unusable");
	});
});
