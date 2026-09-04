import {describe, expect, it} from "vitest";
import {type RollupRun, rollupOf, statusOf} from "./rollup.ts";

const done = (conclusion: string): RollupRun => ({status: "completed", conclusion});
const running = (status = "in_progress"): RollupRun => ({status, conclusion: null});
const concludedWithout: RollupRun = {status: "completed", conclusion: null};

describe("rollupOf", () => {
	it("is green only when every run completed and each concluded non-blocking", () => {
		expect(rollupOf([done("success"), done("neutral"), done("skipped")])).toBe("green");
	});

	it("reds on failure, timed_out and action_required", () => {
		for (const conclusion of ["failure", "timed_out", "action_required"]) {
			expect(rollupOf([done("success"), done(conclusion)])).toBe("red");
		}
	});

	it("reds on cancelled — a cancelled check proved nothing, and that must not read green", () => {
		expect(rollupOf([done("cancelled")])).toBe("red");
	});

	it("reds on a conclusion the vocabulary has never seen, never drops it silently", () => {
		expect(rollupOf([done("success"), done("some_future_conclusion")])).toBe("red");
		expect(rollupOf([concludedWithout])).toBe("red");
	});

	it("is pending when nothing is red and something is still in flight", () => {
		expect(rollupOf([done("success"), running()])).toBe("pending");
		expect(rollupOf([running("queued")])).toBe("pending");
	});

	it("lets red win over pending — a red beside a running check is not pending", () => {
		expect(rollupOf([done("failure"), running()])).toBe("red");
	});
});

describe("statusOf", () => {
	it("prints the conclusion once completed and the status while in flight", () => {
		expect(statusOf(done("success"))).toBe("success");
		expect(statusOf(running("queued"))).toBe("queued");
	});

	it("prints `unknown` for a completed run with no conclusion, never a passing token", () => {
		expect(statusOf(concludedWithout)).toBe("unknown");
	});
});
