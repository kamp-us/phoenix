import {describe, expect, it} from "vitest";
import {type BuildResult, backOffResult, isCoderBackOff} from "./post-build.ts";
import {StageAborted, stageResult} from "./stage-result.ts";

const built = (over: Partial<BuildResult> = {}): BuildResult => ({
	pr: 42,
	headSha: "abc1234",
	...over,
});

describe("isCoderBackOff — sanctioned coder back-off detection (issue #1682)", () => {
	it("detects a back-off on the canonical pr === 0 (no PR opened)", () => {
		expect(
			isCoderBackOff(built({pr: 0, headSha: "none — no PR opened: precondition failed"})),
		).toBe(true);
	});

	it("proceeds (not a back-off) on a real, positive PR number", () => {
		expect(isCoderBackOff(built({pr: 1909}))).toBe(false);
		expect(isCoderBackOff(built({pr: 42}))).toBe(false);
	});

	it("treats a negative or non-integer pr as a back-off (fail-closed — never fetch pulls/0)", () => {
		expect(isCoderBackOff(built({pr: -1}))).toBe(true);
		expect(isCoderBackOff(built({pr: Number.NaN}))).toBe(true);
		expect(isCoderBackOff(built({pr: 3.5}))).toBe(true);
	});
});

describe("backOffResult — the distinct terminal result (issue #1682 AC)", () => {
	it("is unambiguously separable from a freeze-after-2 frozen result", () => {
		const r = backOffResult(716, built({pr: 0, headSha: "none — no PR opened", blocker: 1673}));
		expect(r.backedOff).toBe(true);
		expect(r.pr).toBe(0);
		expect(r.issue).toBe(716);
		expect(r.blocker).toBe(1673);
		// no `frozen` key — the two terminal shapes never collide
		expect(r).not.toHaveProperty("frozen");
	});

	it("carries the blocker only when the coder emitted a real one", () => {
		expect(backOffResult(716, built({pr: 0})).blocker).toBeUndefined();
		expect(backOffResult(716, built({pr: 0, blocker: 0})).blocker).toBeUndefined();
		expect(backOffResult(716, built({pr: 0, blocker: 1673})).blocker).toBe(1673);
	});
});

// The property the whole guard exists to enforce: a back-off return dispatches NO reviewer
// and NO repair round. We assert it at the routing seam — the workflow's review/repair loop
// runs iff `isCoderBackOff` is false — with a fake dispatcher that records every dispatch.
describe("post-build routing — a back-off short-circuits the review/repair loop (issue #1682)", () => {
	/** Mirror of the workflow's post-build branch over the pure predicate; records dispatches. */
	const drivePostBuild = (issue: number, b: BuildResult, dispatched: string[]) => {
		if (isCoderBackOff(b)) {
			return backOffResult(issue, b);
		}
		// the review/repair loop — only reachable on a real PR
		dispatched.push("review");
		return {shipped: true, pr: b.pr};
	};

	it("dispatches NO reviewer/repair when the coder backs off (pr === 0)", () => {
		const dispatched: string[] = [];
		const out = drivePostBuild(716, built({pr: 0, blocker: 1673}), dispatched);
		expect(dispatched).toEqual([]); // no reviewer, no repair, no pulls/0 fetch
		expect(out).toMatchObject({backedOff: true, pr: 0, blocker: 1673});
	});

	it("dispatches the reviewer on a real PR (the unchanged happy path)", () => {
		const dispatched: string[] = [];
		const out = drivePostBuild(716, built({pr: 1909}), dispatched);
		expect(dispatched).toEqual(["review"]);
		expect(out).toMatchObject({shipped: true, pr: 1909});
	});
});

// Strengthen #1692: a null agent-result at a stage boundary yields the structured abort
// (StageAborted → the workflow's `{ aborted }` return), never a raw TypeError.
describe("stageResult — a null agent() result aborts cleanly, not a TypeError (issue #1692)", () => {
	it("returns a non-null object result unchanged", () => {
		const r = {verdict: "PASS", sha: "abc"};
		expect(stageResult("review", r)).toBe(r);
	});

	it("throws StageAborted (naming the stage + PR) on a null result — the field deref never runs", () => {
		expect(() => stageResult("review", null, 1909)).toThrow(StageAborted);
		try {
			stageResult("review", null, 1909);
		} catch (e) {
			expect(e).toBeInstanceOf(StageAborted);
			const err = e as StageAborted;
			expect(err.stage).toBe("review");
			expect(err.pr).toBe(1909);
		}
	});

	it("throws StageAborted on undefined and on a non-object (a dead/skipped subagent)", () => {
		expect(() => stageResult("build", undefined)).toThrow(StageAborted);
		expect(() => stageResult("build", "not-an-object")).toThrow(StageAborted);
	});
});
