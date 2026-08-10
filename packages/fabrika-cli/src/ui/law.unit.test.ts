import {describe, expect, it} from "vitest";
import {parseRegistry} from "./law.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
	id: "faint-token-meaning",
	pillar: "color",
	class: "blocking",
	machineCheck: "vlm",
	source: "design-system-manifest.md#four-pillars",
	statement: "A meaning-carrying label never sits on a decorative faint token.",
	counterexample: "Timestamp-styled --text-faint on the error banner's message.",
	...overrides,
});

const parse = (rows: ReadonlyArray<unknown>) => parseRegistry(JSON.stringify({rows}));

describe("parseRegistry", () => {
	it("returns the rows verbatim, in file order", () => {
		const parsed = parse([row(), row({id: "second-row"})]);
		expect(parsed._tag).toBe("Rows");
		if (parsed._tag !== "Rows") return;
		expect(parsed.rows.map((r) => r.id)).toEqual(["faint-token-meaning", "second-row"]);
	});

	it("refuses zero rows — a law file that names no law is malformed, not minimal", () => {
		expect(parse([])).toEqual({
			_tag: "Violation",
			violation: '"rows" is empty — a law file that names no law',
		});
	});

	/** Whole-file, always: a generator holding half the law believes it holds the law. */
	it.each([
		[
			"a missing field",
			row({statement: undefined}),
			"rows[0].statement is missing or not a string",
		],
		["an unknown field", row({extra: "x"}), 'rows[0] carries an unknown field "extra"'],
		[
			"an off-enum class",
			row({class: "advisery"}),
			'rows[0].class "advisery" is off its enum (blocking | advisory)',
		],
		[
			"an off-enum machineCheck",
			row({machineCheck: "eyeball"}),
			'rows[0].machineCheck "eyeball" is off its enum (verb | vlm | none)',
		],
		["a non-kebab id", row({id: "Faint Token"}), 'rows[0].id "Faint Token" is not kebab-case'],
	])("refuses the whole file on %s", (_label, bad, violation) => {
		expect(parse([bad])).toEqual({_tag: "Violation", violation});
	});

	it("refuses a duplicate id, naming the second occurrence", () => {
		expect(parse([row(), row()])).toEqual({
			_tag: "Violation",
			violation: 'rows[1].id "faint-token-meaning" is a duplicate',
		});
	});

	it("refuses bytes that are not JSON at all", () => {
		const parsed = parseRegistry("{");
		expect(parsed._tag).toBe("Violation");
	});

	it("refuses a top level that carries no rows array", () => {
		expect(parseRegistry('{"prohibitions":[]}')).toEqual({
			_tag: "Violation",
			violation: '"rows" is missing or not an array',
		});
	});
});
