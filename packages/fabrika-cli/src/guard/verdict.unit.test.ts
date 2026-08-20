import {describe, expect, it} from "vitest";
import {atFile} from "./annotate.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	skipped,
	unknown,
	verdictCode,
	violation,
	zeroScope,
} from "./verdict.ts";

const ACTIONS = {GITHUB_ACTIONS: "true"};

describe("verdictCode", () => {
	// The three refusals are three numbers on purpose: CI reds on all of them, and a human
	// reproducing the red needs to know whether the rule broke or the read did.
	it("seats each verdict on its own code", () => {
		expect(verdictCode(clean("all good", 3))).toBe(0);
		expect(verdictCode(violation("broken"))).toBe(VIOLATION);
		expect(verdictCode(zeroScope("nothing scanned"))).toBe(ZERO_SCOPE);
		expect(verdictCode(unknown("could not read"))).toBe(PRECONDITION_UNKNOWN);
	});

	it("never collapses zero scope onto the clean exit (ADR 0092)", () => {
		expect(verdictCode(zeroScope("nothing scanned"))).not.toBe(0);
	});

	// A declared absence is the repo answering the question, not the scan failing to (#6433) — the
	// one shape ADR 0092's floor is not about.
	it("exits a skipped guard 0, and puts its declaration on stdout", () => {
		const verdict = skipped("guard x: this repo declares it keeps none");
		expect(verdictCode(verdict)).toBe(0);
		expect(emitVerdict(verdict, ACTIONS)).toEqual({
			code: 0,
			stdout: "guard x: this repo declares it keeps none\n",
			stderr: [],
		});
	});
});

describe("emitVerdict", () => {
	it("puts a clean summary on stdout and nothing on stderr", () => {
		expect(emitVerdict(clean("all 3 members carry a README", 3), ACTIONS)).toEqual({
			code: 0,
			stdout: "all 3 members carry a README\n",
			stderr: [],
		});
	});

	// The interface convention's invariant: a non-zero exit carries NOTHING on stdout, so a caller
	// cannot read the bytes without reading the status.
	it("leaves stdout empty on every refusal", () => {
		for (const verdict of [violation("v"), zeroScope("z"), unknown("u")]) {
			expect(emitVerdict(verdict, ACTIONS).stdout).toBe("");
		}
	});

	it("puts the report on stderr, with the guard's annotations after it under Actions", () => {
		const outcome = emitVerdict(
			violation("the report", [atFile("error", "a/b.ts", "boom")]),
			ACTIONS,
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr).toEqual(["the report", "::error file=a/b.ts::boom"]);
	});

	it("emits the report alone off a runner", () => {
		const outcome = emitVerdict(violation("the report", [atFile("error", "a/b.ts", "boom")]), {});
		expect(outcome.stderr).toEqual(["the report"]);
	});

	// A zero-scope red carries no per-file finding, so without the fallback it would render a blank
	// check surface — the failure visible only to whoever opens the log (#3868).
	it("falls back to one bare ::error for a verdict that named no file", () => {
		expect(emitVerdict(zeroScope("scanned ZERO members"), ACTIONS).stderr).toEqual([
			"scanned ZERO members",
			"::error::scanned ZERO members",
		]);
	});
});

describe("annotationsOrNone", () => {
	it("returns what the builder built", () => {
		expect(annotationsOrNone(() => [atFile("error", "a.ts", "x")])).toHaveLength(1);
	});

	// The throw would otherwise land while the red verdict is being constructed and take the human
	// report with it — the diagnostic dying exactly when the guard goes red.
	it("degrades a throwing builder to no annotations rather than losing the report", () => {
		expect(
			annotationsOrNone(() => {
				throw new Error("boom");
			}),
		).toEqual([]);
	});
});
