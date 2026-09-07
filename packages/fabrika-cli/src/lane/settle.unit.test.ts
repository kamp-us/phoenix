/** What one board read entitles — the four answers, and the reads that entitle nothing. */
import {describe, expect, it} from "vitest";
import type {PullFact} from "./prove.ts";
import {CANCELLATION_OUTCOME_TOKENS, entitlement, mergedLinking} from "./settle.ts";

const ISSUE = 5983;

const fact = (over: Partial<PullFact> = {}): PullFact => ({
	number: 6874,
	open: false,
	merged: true,
	linkedIssues: [ISSUE],
	linkKind: "fixes",
	...over,
});

describe("the settlement entitlement", () => {
	it("cancels a not-planned close, carrying the outcome the line will record", () => {
		expect(entitlement(ISSUE, "closed", "not_planned", null)).toEqual({
			_tag: "Cancellable",
			event: "CANCELLED",
			outcome: "not_planned",
		});
	});

	it("cancels a duplicate close the same way — the shape `triage kill` leaves behind", () => {
		expect(entitlement(ISSUE, "closed", "duplicate", null)).toMatchObject({
			_tag: "Cancellable",
			outcome: "duplicate",
		});
	});

	it("lands a completed close over a merged PR linking the issue", () => {
		expect(entitlement(ISSUE, "closed", "completed", [fact()])).toEqual({
			_tag: "Landed",
			event: "LANDED",
			outcome: "completed",
			landed: [6874],
		});
	});

	it("lands over a merged `Part of` PR too — the merge is the evidence, not the keyword", () => {
		expect(entitlement(ISSUE, "closed", "completed", [fact({linkKind: "part-of"})])).toMatchObject({
			_tag: "Landed",
			landed: [6874],
		});
	});

	it("names every merged linking PR, so an epic tail's landing is not reported as one merge", () => {
		const read = entitlement(ISSUE, "closed", "completed", [fact(), fact({number: 6900})]);

		expect(read).toMatchObject({_tag: "Landed", landed: [6874, 6900]});
	});

	it("refuses an open issue: its closure has said nothing yet", () => {
		expect(entitlement(ISSUE, "open", null, null)).toEqual({_tag: "Live"});
		expect(entitlement(ISSUE, "open", "reopened", null)).toEqual({_tag: "Live"});
	});

	it("reads a close carrying no reason as UNKNOWN, never as a generous not-planned", () => {
		expect(entitlement(ISSUE, "closed", null, null)._tag).toBe("Unknown");
	});

	it("reads a reason outside the three as UNKNOWN", () => {
		const read = entitlement(ISSUE, "closed", "reopened", null);

		expect(read._tag).toBe("Unknown");
		expect(read._tag === "Unknown" && read.reason).toContain("reopened");
	});

	it("reads a completed close with no merged linking PR as UNKNOWN, never as a landing", () => {
		expect(entitlement(ISSUE, "closed", "completed", [])._tag).toBe("Unknown");
		expect(entitlement(ISSUE, "closed", "completed", [fact({merged: false})])._tag).toBe("Unknown");
		expect(entitlement(ISSUE, "closed", "completed", [fact({linkedIssues: [42]})])._tag).toBe(
			"Unknown",
		);
	});

	it("reads a completed close whose pull requests were never read as UNKNOWN", () => {
		expect(entitlement(ISSUE, "closed", "completed", null)._tag).toBe("Unknown");
	});

	it("counts a merged linking PR and nothing else as landed evidence", () => {
		const facts = [fact(), fact({number: 1, merged: false}), fact({number: 2, linkedIssues: [9]})];

		expect(mergedLinking(ISSUE, facts).map((one) => one.number)).toEqual([6874]);
	});

	it("names only the outcomes a cancellation may stand on", () => {
		expect(CANCELLATION_OUTCOME_TOKENS).toEqual(["duplicate", "not_planned"]);
	});
});
