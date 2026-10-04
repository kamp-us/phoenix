import {describe, expect, it} from "vitest";
import type {IssueDocument} from "../io/issue-document.ts";
import {closedCutoff, DuplicateIndex, inWindow, RETRIEVAL_LIMIT} from "./issue-index.ts";

const issue = (number: number, title: string, body = ""): IssueDocument => ({
	number,
	title,
	body,
	state: "open",
	closed_at: null,
});

describe("DuplicateIndex", () => {
	it("finds body-only matches without an AND query", () => {
		const result = new DuplicateIndex([
			issue(1, "Networking", "retry helper drops cancellation"),
		]).search("unrelated leading words retry cancellation", [], 20, null);
		expect(result.candidates.map((row) => row.number)).toEqual([1]);
	});
	it("keeps the different winners from title and body lists before the caller cap", () => {
		const rows = [
			issue(1, "needle special", "noise ".repeat(800)),
			issue(2, "Other", "needle needle"),
		];
		for (let n = 3; n < RETRIEVAL_LIMIT + 3; n++)
			rows.push(issue(n, "needle", "noise ".repeat(100)));
		const result = new DuplicateIndex(rows).search("needle special", [], 40, null);
		expect(result.candidates.map((row) => row.number)).toContain(1);
		expect(result.candidates.map((row) => row.number)).toContain(2);
	});
	it("excludes before ranking and breaks ties deterministically", () => {
		const rows = Array.from({length: 22}, (_, i) => issue(i + 1, "retry helper"));
		const result = new DuplicateIndex(rows).search("retry helper", [], 1, 22);
		expect(result.candidates[0]?.number).toBe(21);
		expect(result.truncated).toBe(true);
	});
	it("overlays a fresh queue row and only returns each issue once", () => {
		const result = new DuplicateIndex([issue(1, "old title")]).search(
			"retry helper",
			[issue(1, "retry helper"), issue(2, "retry helper")],
			20,
			null,
		);
		expect(result.candidates).toHaveLength(2);
		expect(result.candidates.find((row) => row.number === 1)).toMatchObject({
			title: "retry helper",
			source: "both",
			state: "open",
		});
	});
	it("keeps Unicode words and rejects a real negative", () => {
		const index = new DuplicateIndex([issue(1, "görünürlük düzenleme")]);
		expect(index.search("görünürlük düzenleme", [], 20, null).outcome).toBe("candidates");
		expect(index.search("retry helper", [], 20, null).outcome).toBe("none");
		expect(index.search("the thing", [], 20, null).outcome).toBe("indeterminate");
	});
	it("searches beyond the old twelve-token prefix", () => {
		const result = new DuplicateIndex([issue(1, "cancellation retry")]).search(
			"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november cancellation retry",
			[],
			20,
			null,
		);
		expect(result.candidates.map((row) => row.number)).toEqual([1]);
	});
});

it("includes the closed boundary, excludes one millisecond before it, and keeps old open issues", () => {
	const now = Date.parse("2026-09-19T12:00:00Z");
	const cutoff = closedCutoff(now, 14);
	const closed = {...issue(1, "old report"), state: "closed" as const, closed_at: cutoff};
	expect(inWindow(closed, cutoff, 14)).toBe(true);
	expect(
		inWindow({...closed, closed_at: new Date(Date.parse(cutoff) - 1).toISOString()}, cutoff, 14),
	).toBe(false);
	expect(inWindow(closed, cutoff, 0)).toBe(false);
	expect(inWindow(issue(2, "old open report"), cutoff, 14)).toBe(true);
});
