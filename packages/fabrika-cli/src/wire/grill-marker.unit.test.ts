/**
 * The shared marker vocabulary, driven directly.
 *
 * `./conformance.unit.test.ts` already drives the three registered rows through the totality laws.
 * What it cannot show is the discrimination *inside* a refusal: that a drifted digest and a drifted
 * timestamp name different fields, and that the three keys stay strangers to one another. A reader
 * told only "malformed" re-posts the same marker.
 */
import {describe, expect, it} from "vitest";
import * as grillAnswer from "./grill-answer.ts";
import {
	composeQuestionId,
	markerTime,
	questionId,
	roundDigest,
	roundOf,
	stampOf,
} from "./grill-marker.ts";
import * as grillRuling from "./grill-ruling.ts";
import * as grillSupersede from "./grill-supersede.ts";

describe("the branded fields admit exactly their own shape", () => {
	it.each(["R1.1", "R12.7"])("accepts the question id %s", (raw) => {
		expect(questionId(raw)).toBe(raw);
	});

	it.each([
		"1.1",
		"R0.1",
		"R1.0",
		"R1",
		"R1.1.1",
		"",
		"question one",
	])("refuses the question id %s", (raw) => {
		expect(questionId(raw)).toBeNull();
	});

	it.each(["a1b2c3d4e5f6", "000000000000"])("accepts the digest %s", (raw) => {
		expect(roundDigest(raw)).toBe(raw);
	});

	it.each([
		"A1B2C3D4E5F6",
		"a1b2c3d4e5f",
		"a1b2c3d4e5f6a",
		"nothexatall",
		"",
	])("refuses the digest %s", (raw) => {
		expect(roundDigest(raw)).toBeNull();
	});

	it.each(["2026-08-09T18:36:48Z", "2026-08-09T18:36:48.123Z"])("accepts the stamp %s", (raw) => {
		expect(markerTime(raw)).toBe(raw);
	});

	it.each([
		"2026-08-09 18:36:48",
		"2026-08-09T18:36:48+03:00",
		"yesterday",
		"",
	])("refuses the stamp %s", (raw) => {
		expect(markerTime(raw)).toBeNull();
	});

	it("reads a question id's round back without re-parsing the string at the call site", () => {
		expect(roundOf(questionId("R12.7") ?? ("" as never))).toBe(12);
	});

	it("refuses to compose an id from a non-positive coordinate", () => {
		expect(composeQuestionId(0, 1)).toBeNull();
		expect(composeQuestionId(1, 0)).toBeNull();
		expect(composeQuestionId(2, 3)).toBe("R2.3");
	});

	it("stamps an instant to the second", () => {
		expect(stampOf(new Date("2026-08-09T18:36:48.123Z"))).toBe("2026-08-09T18:36:48Z");
	});
});

describe("each refusal names the field that drifted", () => {
	const reasonOf = (artifact: string): string => {
		const read = grillRuling.read(artifact);
		return read._tag === "Malformed" ? read.reason : `expected Malformed, got ${read._tag}`;
	};

	it.each([
		["the digest", "grill-ruled: R2.3 @ NOTHEX · 2026-08-09T18:36:48Z\n", "round digest"],
		["the timestamp", "grill-ruled: R2.3 @ a1b2c3d4e5f6 · yesterday\n", "ISO-8601"],
		["the question id", "grill-ruled: 2.3 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z\n", "question id"],
		["the binding itself", "grill-ruled: R2.3 · 2026-08-09T18:36:48Z\n", "@ <digest>"],
	])("names %s", (_case, artifact, expected) => {
		expect(reasonOf(artifact)).toContain(expected);
	});
});

describe("the three keys are strangers to one another", () => {
	const ruling = "grill-ruled: R2.3 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z\n";
	const answered = "grill-answered: R2.1 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z\n";
	const superseded = "grill-superseded: R1.4 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z\n";

	it("reads a ruling as absent to the answer format and vice versa", () => {
		expect(grillAnswer.read(ruling)._tag).toBe("Absent");
		expect(grillRuling.read(answered)._tag).toBe("Absent");
	});

	it("reads a supersede marker as absent to both stamp formats", () => {
		expect(grillRuling.read(superseded)._tag).toBe("Absent");
		expect(grillAnswer.read(superseded)._tag).toBe("Absent");
	});

	it("reads a marker quoted further down a comment as absent — a marker is the first line", () => {
		expect(grillRuling.read(`He asked about this:\n\n${ruling}`)._tag).toBe("Absent");
	});

	it("reads a bolded marker, which is how a skill writes emphasis", () => {
		expect(grillRuling.read(`**${ruling.trim()}**\n`)._tag).toBe("Found");
	});
});

describe("the supersede marker carries one entry per retired question", () => {
	it("reads every line", () => {
		const read = grillSupersede.read(
			"grill-superseded: R1.4 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z\ngrill-superseded: R1.5 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z\n",
		);
		expect(read._tag).toBe("Found");
		if (read._tag !== "Found") return;
		expect(read.value.map((entry) => entry.question)).toEqual(["R1.4", "R1.5"]);
		expect(read.value[0]?.round).toBe(2);
	});

	it("is Malformed when any one line drifts — never a shorter Found", () => {
		const read = grillSupersede.read(
			"grill-superseded: R1.4 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z\ngrill-superseded: R1.5 @ 7c1d4a9b2e60 · round two · 2026-08-09T18:36:48Z\n",
		);
		expect(read._tag).toBe("Malformed");
	});

	it("round-trips its read output back through its own emit", () => {
		const bytes = "grill-superseded: R1.4 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z\n";
		const read = grillSupersede.readToLines(bytes);
		expect(read._tag).toBe("Found");
		if (read._tag !== "Found") return;
		expect(grillSupersede.emitFromFields(read.value.join("\n"))).toEqual({
			_tag: "Composed",
			bytes,
		});
	});
});
