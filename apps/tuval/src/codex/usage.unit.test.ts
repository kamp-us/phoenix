import {describe, expect, it} from "vitest";
import {TurnUsage} from "./usage.ts";

describe("Codex turn usage", () => {
	it("collects multiple model requests into one final report and ignores repeated totals", () => {
		const usage = new TurnUsage();
		usage.record("a", {inputTokens: 10, outputTokens: 2}, {inputTokens: 10, outputTokens: 2});
		usage.record("a", {inputTokens: 30, outputTokens: 5}, {inputTokens: 20, outputTokens: 3});
		usage.record("a", {inputTokens: 30, outputTokens: 5}, {inputTokens: 20, outputTokens: 3});
		expect(usage.finish("a")).toEqual({inputTokens: 30, outputTokens: 5});
		expect(usage.finish("a")).toBeUndefined();
		usage.record("b", {inputTokens: 35, outputTokens: 6}, {inputTokens: 5, outputTokens: 1});
		expect(usage.finish("b")).toEqual({inputTokens: 5, outputTokens: 1});
	});
	it("does not charge an entire resumed thread to its first observed turn", () => {
		const usage = new TurnUsage();
		usage.record("new", {inputTokens: 1010, outputTokens: 202}, {inputTokens: 10, outputTokens: 2});
		expect(usage.finish("new")).toEqual({inputTokens: 10, outputTokens: 2});
	});
});
