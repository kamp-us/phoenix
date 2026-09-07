/** What one board read entitles — the three answers, and the reads that entitle nothing. */
import {describe, expect, it} from "vitest";
import {CANCELLATION_OUTCOME_TOKENS, entitlement} from "./cancel.ts";

describe("the cancellation entitlement", () => {
	it("entitles a not-planned close, carrying the outcome the line will record", () => {
		expect(entitlement("closed", "not_planned")).toEqual({
			_tag: "Cancellable",
			outcome: "not_planned",
		});
	});

	it("entitles a duplicate close the same way — the shape `triage kill` leaves behind", () => {
		expect(entitlement("closed", "duplicate")).toEqual({
			_tag: "Cancellable",
			outcome: "duplicate",
		});
	});

	it("sends a completed close to the shipped path rather than cancelling landed work", () => {
		expect(entitlement("closed", "completed")).toEqual({_tag: "Landed"});
	});

	it("refuses an open issue: there is live work here and no closure to stand on", () => {
		expect(entitlement("open", null)).toEqual({_tag: "Live"});
		expect(entitlement("open", "reopened")).toEqual({_tag: "Live"});
	});

	it("reads a close carrying no reason as UNKNOWN, never as a generous not-planned", () => {
		const read = entitlement("closed", null);

		expect(read._tag).toBe("Unknown");
	});

	it("reads a reason outside the closed set as UNKNOWN, never as a cancellation", () => {
		const read = entitlement("closed", "reopened");

		expect(read._tag).toBe("Unknown");
		expect(read._tag === "Unknown" && read.reason).toContain("reopened");
	});

	it("names only the outcomes a recorded line may carry", () => {
		expect(CANCELLATION_OUTCOME_TOKENS).toEqual(["duplicate", "not_planned"]);
	});
});
