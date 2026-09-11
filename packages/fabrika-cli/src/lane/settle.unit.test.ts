/** What one board read entitles — the four answers, and the reads that entitle nothing. */
import {describe, expect, it} from "vitest";
import type {PullFact} from "./prove.ts";
import {
	type AssertedPull,
	CANCELLATION_OUTCOME_TOKENS,
	entitlement,
	mergedLinking,
} from "./settle.ts";

const ISSUE = 5983;

const fact = (over: Partial<PullFact> = {}): PullFact => ({
	number: 6874,
	open: false,
	merged: true,
	linkedIssues: [ISSUE],
	linkKind: "fixes",
	referencedIssues: over.linkedIssues ?? [ISSUE],
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

	it("lands an epic over its own tail, which closes the children and only names the epic", () => {
		const tail = fact({
			number: 8996,
			linkedIssues: [7940, 7941],
			linkKind: "fixes",
			referencedIssues: [7940, 7941, ISSUE],
		});

		expect(entitlement(ISSUE, "closed", "completed", [tail])).toMatchObject({
			_tag: "Landed",
			landed: [8996],
		});
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

describe("the link a caller asserts", () => {
	const merged: AssertedPull = {_tag: "Merged", number: 6894, sha: "cafe"};

	it("lands a completed close over the merge the caller named, marked asserted", () => {
		expect(entitlement(ISSUE, "closed", "completed", [], merged)).toEqual({
			_tag: "Landed",
			event: "LANDED",
			outcome: "completed",
			landed: [6894],
			assertedBy: "caller",
		});
	});

	it("prefers the body-proven landing, so an assertion can only ever fill a gap", () => {
		expect(entitlement(ISSUE, "closed", "completed", [fact()], merged)).toEqual({
			_tag: "Landed",
			event: "LANDED",
			outcome: "completed",
			landed: [6874],
		});
	});

	it("refuses a named pull request that has not merged — there is no landing yet", () => {
		expect(
			entitlement(ISSUE, "closed", "completed", [], {
				_tag: "Unmerged",
				number: 6894,
				state: "open",
			}),
		).toEqual({_tag: "AssertedUnmerged", pr: 6894, state: "open"});
	});

	it("refuses a named pull request the board does not hold", () => {
		expect(entitlement(ISSUE, "closed", "completed", [], {_tag: "Absent", number: 6894})).toEqual({
			_tag: "AssertedAbsent",
			pr: 6894,
		});
	});

	it("leaves every other closure untouched: an assertion entitles no cancellation and no live lane", () => {
		expect(entitlement(ISSUE, "closed", "not_planned", null, merged)._tag).toBe("Cancellable");
		expect(entitlement(ISSUE, "open", null, null, merged)._tag).toBe("Live");
		expect(entitlement(ISSUE, "closed", null, null, merged)._tag).toBe("Unknown");
		expect(entitlement(ISSUE, "closed", "completed", null, merged)._tag).toBe("Unknown");
	});

	it("names the flag in the refusal a caller without one reads", () => {
		const read = entitlement(ISSUE, "closed", "completed", []);

		expect(read._tag === "Unknown" && read.reason).toContain("--landed-by");
	});
});
