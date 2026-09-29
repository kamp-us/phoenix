import {describe, expect, it} from "vitest";
import {emit, parseFields, read} from "./build-deviations.ts";

const entry =
	"- **Scope narrowing** — **Said:** both surfaces. **Did:** the reader only. **Why:** the writer is the next child's range. **Disposition:** stated here.";

describe("read", () => {
	it("finds the issue and the entries under the section", () => {
		const result = read(`build-deviations: #3\n\n## Deviations\n\n${entry}\n`);
		expect(result).toMatchObject({
			_tag: "Found",
			value: {issue: 3, disclosure: {_tag: "Entries"}},
		});
	});

	it("finds the None. claim as NoneDeclared, not as an empty list", () => {
		expect(read("build-deviations: #3\n\n## Deviations\n\nNone.\n")).toEqual({
			_tag: "Found",
			value: {issue: 3, disclosure: {_tag: "NoneDeclared"}},
		});
	});

	it("does not read a marker quoted further down the body", () => {
		expect(
			read(`A child would post:\n\nbuild-deviations: #3\n\n## Deviations\n\nNone.\n`)._tag,
		).toBe("Absent");
	});
});

describe("emit", () => {
	it("round-trips the None. claim through read", () => {
		const composed = emit({issue: 3, disclosure: {_tag: "NoneDeclared"}});
		expect(read(composed)).toMatchObject({
			_tag: "Found",
			value: {issue: 3, disclosure: {_tag: "NoneDeclared"}},
		});
	});
});

describe("parseFields", () => {
	it("takes the issue line, then the section's fields as the deviations format takes them", () => {
		const parsed = parseFields("issue: 3\nNone.\n");
		expect(parsed).toEqual({
			_tag: "Fields",
			value: {issue: 3, disclosure: {_tag: "NoneDeclared"}},
		});
	});

	it("tolerates a leading # on the issue, which is how a human writes it", () => {
		expect(parseFields("issue: #3\nNone.\n")._tag).toBe("Fields");
	});

	it.each([
		["no issue line", "None.\n"],
		["an issue that is not a number", "issue: the editor one\nNone.\n"],
		["an entry line missing a field", "issue: 3\n1\tsaid\tdid\twhy\n"],
	])("refuses %s", (_case, fields) => {
		expect(parseFields(fields)._tag).toBe("Unusable");
	});
});
