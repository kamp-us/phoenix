import {describe, expect, it} from "vitest";
import {readGrillAnswer} from "./source.ts";

const WELL_SHAPED = JSON.stringify({
	questions: [],
	frontier: "R1",
	scanned: {comments: 3, rounds: 1},
});

describe("the grilling resolver's stdout is read as its answer or as nothing", () => {
	it("reads a well-shaped answer", () => {
		expect(readGrillAnswer(WELL_SHAPED)).toMatchObject({frontier: "R1"});
	});

	it("returns nothing for bytes that are not JSON at all", () => {
		expect(readGrillAnswer("grill read: 3 comment(s)\n")).toBeUndefined();
	});

	it("returns nothing for a truncated payload", () => {
		expect(readGrillAnswer(WELL_SHAPED.slice(0, 20))).toBeUndefined();
	});

	it("returns nothing when a field this verb reads is renamed or retyped", () => {
		expect(readGrillAnswer(JSON.stringify({frontier: "R1", scanned: {}}))).toBeUndefined();
		expect(
			readGrillAnswer(JSON.stringify({questions: [], frontier: 1, scanned: {}})),
		).toBeUndefined();
		expect(
			readGrillAnswer(JSON.stringify({questions: [], frontier: "R1", scanned: null})),
		).toBeUndefined();
	});

	it("returns nothing for JSON that is not an object", () => {
		expect(readGrillAnswer("[]")).toBeUndefined();
		expect(readGrillAnswer("null")).toBeUndefined();
	});
});
