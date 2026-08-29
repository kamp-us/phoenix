import {describe, expect, it} from "vitest";
import {FABRIKA_SUBAGENT_DEPTH, raiseSubagentDepth} from "./subagent-depth.ts";

describe("raiseSubagentDepth", () => {
	it("raises an unset depth off opencode's default of 1", () => {
		expect(raiseSubagentDepth(undefined)).toBe(FABRIKA_SUBAGENT_DEPTH);
	});

	it("raises a host depth below the floor", () => {
		expect(raiseSubagentDepth(1)).toBe(FABRIKA_SUBAGENT_DEPTH);
	});

	it("leaves a host depth at or above the floor alone", () => {
		expect(raiseSubagentDepth(2)).toBe(2);
		expect(raiseSubagentDepth(4)).toBe(4);
	});
});
