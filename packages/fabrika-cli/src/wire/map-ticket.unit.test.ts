import {describe, expect, it} from "vitest";
import {emit, emitFromFields, parseFields, read, readToLines} from "./map-ticket.ts";

const marker = "map-ticket: #9140 · research · 7f3a9c21";

describe("read", () => {
	it("finds the marker's three fields", () => {
		expect(read(`${marker}\n`)).toEqual({
			_tag: "Found",
			value: {map: 9140, kind: "research", nonce: "7f3a9c21"},
		});
	});

	it("answers Absent for bytes that never reach for the format", () => {
		expect(read("Picking this one up — will report back.\n")._tag).toBe("Absent");
	});

	it("answers Absent for an artifact with no non-blank line at all", () => {
		expect(read("\n \n")._tag).toBe("Absent");
	});

	it.each([
		["an off-vocabulary kind", "map-ticket: #9140 · investigation · 7f3a9c21"],
		["a lane key two runs would collide on", "map-ticket: #9140 · research · run-1"],
		["a missing map field", "map-ticket: research · 7f3a9c21"],
		["a separator that drifted", "map-ticket: #9140 - research - 7f3a9c21"],
	])("answers Malformed, not Absent, on %s", (_drift, artifact) => {
		const result = read(`${artifact}\n`);
		expect(result._tag).toBe("Malformed");
		// The evidence is the offending bytes quoted back, so a reader can see what was judged.
		expect(result._tag === "Malformed" && result.evidence).toContain(artifact);
	});

	it("does not read a marker quoted further down the body", () => {
		expect(read(`Someone wrote:\n\n${marker}\n`)._tag).toBe("Absent");
	});
});

describe("emit", () => {
	it("round-trips through read", () => {
		const composed = emit({map: 9140, kind: "decision", nonce: "0a1b2c3d" as never});
		expect(read(composed)).toMatchObject({_tag: "Found"});
	});
});

describe("parseFields", () => {
	it("takes the fields in any order", () => {
		expect(parseFields("nonce: 7f3a9c21\nkind: prototype\nmap: 9140")).toMatchObject({
			_tag: "Fields",
			marker: {map: 9140, kind: "prototype", nonce: "7f3a9c21"},
		});
	});

	it("tolerates a leading # on the map field, which is how a human writes it", () => {
		expect(parseFields("map: #9140\nkind: research\nnonce: 7f3a9c21")._tag).toBe("Fields");
	});

	it.each([
		["a missing field", "kind: research\nnonce: 7f3a9c21"],
		["a duplicated field", "map: 9140\nmap: 9141\nkind: research\nnonce: 7f3a9c21"],
		["an unknown key", "map: 9140\nkind: research\nnonce: 7f3a9c21\nowner: someone"],
		["an off-vocabulary kind", "map: 9140\nkind: investigation\nnonce: 7f3a9c21"],
		["a bad nonce", "map: 9140\nkind: research\nnonce: run-1"],
	])("refuses %s rather than composing a weaker marker", (_case, fields) => {
		expect(emitFromFields(fields)._tag).toBe("Unusable");
	});
});

describe("readToLines", () => {
	it("renders one <field>\\t<value> line per field", () => {
		expect(readToLines(`${marker}\n`)).toEqual({
			_tag: "Found",
			value: ["map\t9140", "kind\tresearch", "nonce\t7f3a9c21"],
		});
	});
});
