/**
 * Unit tests for the `intake-dedup` pure core (ADR 0181): tokenization, query building,
 * title scoring, and the two-source rank/fuse. IO-free — no `gh` boundary here.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type Candidate,
	type IssueRef,
	rankCandidates,
	searchQuery,
	titleScore,
	tokenize,
} from "./dedup-match.ts";

describe("tokenize", () => {
	it("lowercases and splits on non-alphanumeric runs", () => {
		expect(tokenize("Retry-helper swallows Abort")).toEqual([
			"retry",
			"helper",
			"swallows",
			"abort",
		]);
	});

	it("drops stopwords and sub-3-char tokens", () => {
		// "the"/"in"/"a" are noise; "id" is < 3 chars; "worker" survives.
		expect(tokenize("the id in a worker")).toEqual(["worker"]);
	});

	it("dedupes preserving first-seen order", () => {
		expect(tokenize("cache cache Cache invalidation cache")).toEqual(["cache", "invalidation"]);
	});

	it("drops the report-scaffolding nouns (issue/bug/report)", () => {
		expect(tokenize("bug report: issue with pagination")).toEqual(["pagination"]);
	});

	it("caps at 12 tokens", () => {
		const many = tokenize(
			"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november",
		);
		expect(many.length).toBe(12);
		expect(many[0]).toBe("alpha");
	});

	it("returns empty for all-noise text", () => {
		expect(tokenize("the and for a to")).toEqual([]);
	});
});

describe("searchQuery", () => {
	it("prepends the repo/is:issue/is:open qualifiers, space-joined", () => {
		expect(searchQuery("kamp-us/phoenix", ["retry", "abort"])).toBe(
			"repo:kamp-us/phoenix is:issue is:open retry abort",
		);
	});

	it("emits qualifiers-only when there are no tokens (no trailing raw space)", () => {
		expect(searchQuery("kamp-us/phoenix", [])).toBe("repo:kamp-us/phoenix is:issue is:open");
	});
});

describe("titleScore", () => {
	it("counts query tokens present in the title", () => {
		expect(
			titleScore("Retry helper swallows the abort reason", ["retry", "abort", "missing"]),
		).toBe(2);
	});

	it("is zero when nothing overlaps", () => {
		expect(titleScore("Unrelated pagination fix", ["retry", "abort"])).toBe(0);
	});

	it("is zero for an empty token set", () => {
		expect(titleScore("anything", [])).toBe(0);
	});
});

describe("rankCandidates", () => {
	const q = (n: number, title: string): IssueRef => ({number: n, title});
	const bare = (c: Candidate) => ({number: c.number, source: c.source, score: c.score});

	it("drops queue rows with no title overlap, keeps search rows regardless", () => {
		const out = rankCandidates({
			queue: [q(10, "retry helper abort"), q(11, "totally unrelated")],
			// a search row that matched server-side on the BODY has no title overlap — still kept.
			search: [q(12, "no shared words at all")],
			tokens: ["retry", "abort"],
			limit: 20,
		});
		expect(out.map((c) => c.number).sort((a, b) => a - b)).toEqual([10, 12]);
	});

	it("upgrades a number seen in both sources to source:both with the higher score", () => {
		const out = rankCandidates({
			queue: [q(10, "retry abort helper")],
			search: [q(10, "retry abort helper")],
			tokens: ["retry", "abort", "helper"],
			limit: 20,
		});
		expect(out).toHaveLength(1);
		expect(bare(out[0]!)).toEqual({number: 10, source: "both", score: 3});
	});

	it("ranks by score desc, then newer (higher number) first", () => {
		const out = rankCandidates({
			queue: [q(5, "retry abort helper"), q(9, "retry only"), q(8, "retry only")],
			search: [],
			tokens: ["retry", "abort", "helper"],
			limit: 20,
		});
		expect(out.map((c) => c.number)).toEqual([5, 9, 8]);
	});

	it("excludes the issue being deduped so it never flags itself", () => {
		const out = rankCandidates({
			queue: [q(42, "retry abort helper"), q(43, "retry abort helper")],
			search: [],
			tokens: ["retry", "abort"],
			exclude: 42,
			limit: 20,
		});
		expect(out.map((c) => c.number)).toEqual([43]);
	});

	it("caps the result at limit", () => {
		const out = rankCandidates({
			queue: [q(1, "retry a"), q(2, "retry b"), q(3, "retry c")],
			search: [],
			tokens: ["retry"],
			limit: 2,
		});
		expect(out).toHaveLength(2);
	});
});
