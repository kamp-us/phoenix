import {describe, expect, it} from "vitest";
import {landedRefs} from "./landed.ts";

describe("landedRefs", () => {
	it("reads every issue a message names, subject and body alike", () => {
		expect([
			...landedRefs(["feat(guide): the front door (#6004)\n\nPart of #5817", "chore: nothing"]),
		]).toEqual([6004, 5817]);
	});

	it("is empty for a branch that carries no commit", () => {
		expect(landedRefs([]).size).toBe(0);
	});

	// The same rule `build commit` and `lane prove` read messages with, so a number written without
	// its `#` is not a reference — a discharge off "issue 210" would be a discharge off prose.
	it("does not read a bare number as a reference", () => {
		expect(landedRefs(["fix: closes issue 210"]).size).toBe(0);
	});
});
