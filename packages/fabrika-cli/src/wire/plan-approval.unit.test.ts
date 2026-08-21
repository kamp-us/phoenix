import {describe, expect, it} from "vitest";
import {markerTime} from "./grill-marker.ts";
import {approvedEpic, approves, emit, parseFields, read, scopeDigest} from "./plan-approval.ts";

const EPIC = approvedEpic(5843);
const DIGEST = scopeDigest("4d90e1bb27ac");
const AT = markerTime("2026-08-16T07:16:03Z");
if (EPIC === null || DIGEST === null || AT === null) throw new Error("fixture will not brand");

describe("read", () => {
	it("finds the epic, the digest and the stamp", () => {
		expect(read("plan-approved: #5843 @ 4d90e1bb27ac · 2026-08-16T07:16:03Z\n")).toEqual({
			_tag: "Found",
			value: {epic: 5843, digest: "4d90e1bb27ac", at: "2026-08-16T07:16:03Z"},
		});
	});

	it("reads the marker under a skill's bold emphasis", () => {
		expect(read("**plan-approved: #5843 @ 4d90e1bb27ac · 2026-08-16T07:16:03Z**\n")).toMatchObject({
			_tag: "Found",
			value: {epic: 5843},
		});
	});

	it("answers Absent for a comment that never reaches for the format", () => {
		expect(read("Re-planned the third slice — the topology is smaller now.\n")._tag).toBe("Absent");
	});

	it("does not read a marker quoted further down the body", () => {
		expect(
			read(
				"The founder would post:\n\nplan-approved: #5843 @ 4d90e1bb27ac · 2026-08-16T07:16:03Z\n",
			)._tag,
		).toBe("Absent");
	});

	it("answers Malformed, not Found, when the marker carries no digest", () => {
		const result = read("plan-approved: #5843 · 2026-08-16T07:16:03Z\n");
		expect(result._tag).toBe("Malformed");
	});

	it("answers Malformed for a digest that is not 12 lowercase hex", () => {
		expect(read("plan-approved: #5843 @ 4D90E1BB · 2026-08-16T07:16:03Z\n")._tag).toBe("Malformed");
		expect(read("plan-approved: #5843 @ 4d90e1bb27acff · 2026-08-16T07:16:03Z\n")._tag).toBe(
			"Malformed",
		);
	});

	it("answers Malformed when the epic reference lost its #", () => {
		expect(read("plan-approved: 5843 @ 4d90e1bb27ac · 2026-08-16T07:16:03Z\n")._tag).toBe(
			"Malformed",
		);
	});

	it("answers Malformed when the stamp is not an ISO-8601 UTC instant", () => {
		expect(read("plan-approved: #5843 @ 4d90e1bb27ac · last Thursday\n")._tag).toBe("Malformed");
	});
});

describe("emit", () => {
	it("round-trips through read", () => {
		expect(read(emit({epic: EPIC, digest: DIGEST, at: AT}))).toEqual({
			_tag: "Found",
			value: {epic: 5843, digest: "4d90e1bb27ac", at: "2026-08-16T07:16:03Z"},
		});
	});
});

describe("approves", () => {
	const approval = {epic: EPIC, digest: DIGEST, at: AT};

	it("holds for the epic it names at the digest it binds", () => {
		expect(approves(approval, 5843, "4d90e1bb27ac")).toBe(true);
	});

	it("approves nothing on another epic, however fresh its digest", () => {
		expect(approves(approval, 5844, "4d90e1bb27ac")).toBe(false);
	});

	it("does not survive a re-plan that moved the scope digest", () => {
		expect(approves(approval, 5843, "0000000000ff")).toBe(false);
	});
});

describe("parseFields", () => {
	it("takes the three fields in any order", () => {
		expect(parseFields("at: 2026-08-16T07:16:03Z\nepic: 5843\ndigest: 4d90e1bb27ac\n")).toEqual({
			_tag: "Fields",
			approval: {epic: 5843, digest: "4d90e1bb27ac", at: "2026-08-16T07:16:03Z"},
		});
	});

	it("takes the epic with or without its #, so wire read's own answer pipes back in", () => {
		expect(
			parseFields("epic\t#5843\ndigest\t4d90e1bb27ac\nat\t2026-08-16T07:16:03Z\n"),
		).toMatchObject({_tag: "Fields", approval: {epic: 5843}});
	});

	it("refuses a missing digest rather than composing an unbound marker", () => {
		expect(parseFields("epic: 5843\nat: 2026-08-16T07:16:03Z\n")._tag).toBe("Unusable");
	});

	it("refuses a field given twice", () => {
		expect(
			parseFields("epic: 5843\nepic: 5844\ndigest: 4d90e1bb27ac\nat: 2026-08-16T07:16:03Z\n")._tag,
		).toBe("Unusable");
	});
});
