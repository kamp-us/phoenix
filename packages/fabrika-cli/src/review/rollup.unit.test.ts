import {describe, expect, it} from "vitest";
import type {CheckRun} from "../io/pulls.ts";
import {rollupOf, statusOf} from "./rollup.ts";

const done = (name: string, conclusion: string): CheckRun => ({
	name,
	status: "completed",
	conclusion,
});
const running = (name: string, status = "in_progress"): CheckRun => ({
	name,
	status,
	conclusion: null,
});

describe("rollupOf", () => {
	it("is green only when every run completed and each concluded non-blocking", () => {
		expect(rollupOf([done("a", "success"), done("b", "neutral"), done("c", "skipped")])).toBe(
			"green",
		);
	});

	it("reds on failure, timed_out and action_required", () => {
		for (const conclusion of ["failure", "timed_out", "action_required"]) {
			expect(rollupOf([done("a", "success"), done("b", conclusion)])).toBe("red");
		}
	});

	it("reds on cancelled — a cancelled check proved nothing, and that must not read green", () => {
		expect(rollupOf([done("a", "cancelled")])).toBe("red");
	});

	it("reds on a conclusion the vocabulary has never seen, never drops it silently", () => {
		expect(rollupOf([done("a", "success"), done("b", "some_future_conclusion")])).toBe("red");
		expect(rollupOf([{name: "a", status: "completed", conclusion: null}])).toBe("red");
	});

	it("is pending when nothing is red and something is still in flight", () => {
		expect(rollupOf([done("a", "success"), running("b")])).toBe("pending");
		expect(rollupOf([running("b", "queued")])).toBe("pending");
	});

	it("lets red win over pending — a red beside a running check is not pending", () => {
		expect(rollupOf([done("a", "failure"), running("b")])).toBe("red");
	});
});

describe("statusOf", () => {
	it("prints the conclusion once completed and the status while in flight", () => {
		expect(statusOf(done("a", "success"))).toBe("success");
		expect(statusOf(running("b", "queued"))).toBe("queued");
	});

	it("prints `unknown` for a completed run with no conclusion, never a passing token", () => {
		expect(statusOf({name: "a", status: "completed", conclusion: null})).toBe("unknown");
	});
});
