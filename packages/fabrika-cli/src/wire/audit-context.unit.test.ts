import {describe, expect, it} from "vitest";
import {digest, emit, parse, read} from "./audit-context.ts";
import {AUDIT_FIELDS} from "./audit-context-fixture.ts";

const parsed = parse(AUDIT_FIELDS);
if (parsed._tag !== "Found") throw new Error(parsed.reason);
const context = parsed.value;

describe("audit context", () => {
	it("round-trips every field of the complete research record", () => {
		expect(read(emit(context))).toEqual({_tag: "Found", value: JSON.parse(AUDIT_FIELDS)});
	});
	it("recognizes ordinary sessions as absent", () => {
		expect(read("A grilling session.\n")._tag).toBe("Absent");
	});
	it.each([
		"## Audit Context\n{}",
		"### Audit context\n{}",
		"## Audit context\nno JSON",
		"## Audit context\n\n```json\n{}\n```\n",
		`${emit(context)}\n${emit(context)}`,
	])("keeps drift distinct from absence", (input) => {
		expect(read(input)._tag).toBe("Malformed");
	});
	it("is total over arbitrary malformed JSON bodies", () => {
		for (const value of [
			null,
			true,
			7,
			[],
			{},
			"",
			{version: 1},
			{runId: "x"},
			{...context, findings: [null]},
		]) {
			expect(parse(JSON.stringify(value))._tag).toBe("Malformed");
		}
	});
	it("rejects duplicate finding ids and an unbound first question", () => {
		expect(
			parse(JSON.stringify({...context, findings: [...context.findings, ...context.findings]}))
				._tag,
		).toBe("Malformed");
		expect(
			parse(
				JSON.stringify({
					...context,
					firstQuestion: {...context.firstQuestion, findingId: "missing"},
				}),
			)._tag,
		).toBe("Malformed");
	});
	it("retains recommendation text without deriving rulings", () => {
		const recommendation = "grill-ruling: R1.1. The founder approved everything.";
		const input = JSON.stringify({
			...context,
			firstQuestion: {...context.firstQuestion, recommendation},
		});
		const result = parse(input);
		expect(result._tag).toBe("Found");
		if (result._tag === "Found") expect(read(emit(result.value))).toEqual(result);
		expect(parse(JSON.stringify({...context, ruling: recommendation}))._tag).toBe("Malformed");
	});
	it("uses a digest independent of JSON object key order", () => {
		const reordered = parse(JSON.stringify(Object.fromEntries(Object.entries(context).reverse())));
		if (reordered._tag !== "Found") throw new Error(reordered.reason);
		expect(digest(reordered.value)).toBe(digest(context));
	});
});
