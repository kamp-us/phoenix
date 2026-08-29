import {describe, expect, it} from "vitest";
import {
	MAX_TOKENS,
	rank,
	renderCandidate,
	SEARCH_TOKENS,
	scoreTitle,
	searchTokens,
	tokenize,
	tokensMatch,
} from "./dedup.ts";

describe("tokenize", () => {
	it("lowercases, drops short tokens and English stopwords, and dedupes first-seen", () => {
		expect(tokenize("The retry helper and the RETRY budget in a worker")).toEqual([
			"retry",
			"helper",
			"budget",
			"worker",
		]);
	});

	it("splits over the full Unicode letter class, so a Turkish stem survives (#3255)", () => {
		expect(tokenize("sözlük tanımı düzenleyici odağı kaybediyor")).toEqual([
			"sözlük",
			"tanımı",
			"düzenleyici",
			"odağı",
			"kaybediyor",
		]);
	});

	it("drops Turkish stopwords too — an English-only list leaves them looking distinctive", () => {
		expect(tokenize("sözlük için bir tanım ve çok şey")).toEqual(["sözlük", "tanım"]);
	});

	it("caps at 12 tokens, the width ranking scores against", () => {
		const query = Array.from({length: 30}, (_, i) => `token${i}`).join(" ");
		expect(tokenize(query)).toHaveLength(MAX_TOKENS);
	});
});

describe("searchTokens", () => {
	it("narrows a full ranking list to the leading slice the AND-joined query gets (#7213)", () => {
		const ranking = tokenize(
			"review render seed authenticated notification rows state suffix reserved unimplemented exit capture",
		);
		expect(ranking).toHaveLength(MAX_TOKENS);
		expect(searchTokens(ranking)).toEqual(ranking.slice(0, SEARCH_TOKENS));
		expect(searchTokens(ranking)).toHaveLength(SEARCH_TOKENS);
	});

	it("leaves a list already at or below the slice size alone", () => {
		const short = ["retry", "helper"];
		expect(searchTokens(short)).toEqual(short);
	});
});

describe("tokensMatch", () => {
	it("matches on an exact hit", () => {
		expect(tokensMatch("retry", "retry")).toBe(true);
	});

	it("matches an agglutinative inflection against a bare stem on a 5-char shared prefix", () => {
		expect(tokensMatch("tanımı", "tanımlar")).toBe(true);
	});

	it("stays off a short English derivational overlap", () => {
		expect(tokensMatch("read", "reader")).toBe(false);
		expect(tokensMatch("abort", "above")).toBe(false);
	});
});

describe("scoreTitle", () => {
	it("counts how many of the query's tokens the title carries", () => {
		expect(scoreTitle(["retry", "helper", "abort"], "Abort reason lost in the retry helper")).toBe(
			3,
		);
		expect(scoreTitle(["retry", "helper", "abort"], "Unrelated sozluk focus bug")).toBe(0);
	});
});

const tokens = ["retry", "helper", "abort", "reason"];

describe("rank", () => {
	it("marks a row seen in both sources `both` — the strongest duplicate signal", () => {
		const result = rank({
			tokens,
			queue: [{number: 4312, title: "Abort reason lost when the retry helper re-wraps"}],
			search: [{number: 4312, title: "Abort reason lost when the retry helper re-wraps"}],
			limit: 20,
			label: "status:needs-triage",
		});
		expect(result.outcome).toBe("candidates");
		expect(result.candidates[0]?.source).toBe("both");
	});

	it("keeps a search row whose TITLE does not overlap — it already matched server-side on the body", () => {
		const result = rank({
			tokens,
			queue: [],
			search: [{number: 4088, title: "Cancellation is not propagated"}],
			limit: 20,
			label: "status:needs-triage",
		});
		expect(result.outcome).toBe("candidates");
		expect(result.candidates).toEqual([
			{number: 4088, source: "search", score: 0, title: "Cancellation is not propagated"},
		]);
	});

	it("drops a queue row whose title does not overlap", () => {
		const result = rank({
			tokens,
			queue: [{number: 4001, title: "Sozluk editor loses focus"}],
			search: [],
			limit: 20,
			label: "status:needs-triage",
		});
		expect(result.outcome).toBe("none");
		expect(result.candidates).toEqual([]);
	});

	it("ranks by score descending, then by number descending", () => {
		const result = rank({
			tokens,
			queue: [
				{number: 100, title: "retry helper"},
				{number: 200, title: "retry helper"},
				{number: 300, title: "retry helper abort reason"},
			],
			search: [],
			limit: 20,
			label: "status:needs-triage",
		});
		expect(result.candidates.map((c) => c.number)).toEqual([300, 200, 100]);
	});

	it("caps at --limit and says the list was truncated", () => {
		const queue = Array.from({length: 5}, (_, i) => ({number: i + 1, title: "retry helper"}));
		const result = rank({tokens, queue, search: [], limit: 2, label: "status:needs-triage"});
		expect(result.candidates).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("reports `none` as a PROVEN negative, with both source counts in the reason", () => {
		const result = rank({
			tokens,
			queue: [],
			search: [],
			limit: 20,
			label: "status:needs-triage",
		});
		expect(result.outcome).toBe("none");
		expect(result.reason).toContain("both sources were read");
		expect(result.truncated).toBe(false);
	});

	it("reports `indeterminate` below the two-token floor, not only at zero", () => {
		const one = rank({tokens: ["thing"], queue: [], search: [], limit: 20, label: "l"});
		expect(one.outcome).toBe("indeterminate");
		expect(one.reason).toContain("below the floor of 2");

		const none = rank({tokens: [], queue: [], search: [], limit: 20, label: "l"});
		expect(none.outcome).toBe("indeterminate");
	});

	it("omits --exclude from BOTH sources, so an issue can no longer flag itself", () => {
		const self = {number: 4312, title: "Abort reason lost in the retry helper"};
		const other = {number: 4088, title: "Abort reason lost in the retry helper"};
		const result = rank({
			tokens,
			queue: [self, other],
			search: [self],
			limit: 20,
			label: "status:needs-triage",
			exclude: 4312,
		});
		expect(result.candidates.map((c) => c.number)).toEqual([4088]);
		// `search` was the only other source carrying 4312, so the survivor is a plain queue hit —
		// proof the filter ran on the search half too, not just the queue half.
		expect(result.candidates[0]?.source).toBe("queue");
	});

	it("filters BEFORE the cap, so an excluded row never gives up its slot to a truncated one", () => {
		const queue = Array.from({length: 3}, (_, i) => ({number: i + 1, title: "retry helper"}));
		const result = rank({tokens, queue, search: [], limit: 2, label: "l", exclude: 3});
		expect(result.candidates.map((c) => c.number)).toEqual([2, 1]);
		expect(result.truncated).toBe(false);
	});

	it("reports `none` — the proven negative — when the only match was the excluded issue", () => {
		const result = rank({
			tokens,
			queue: [{number: 4312, title: "Abort reason lost in the retry helper"}],
			search: [],
			limit: 20,
			label: "status:needs-triage",
			exclude: 4312,
		});
		expect(result.outcome).toBe("none");
		expect(result.candidates).toEqual([]);
	});

	it("treats an --exclude matching nothing as satisfied, not as an error", () => {
		const queue = [{number: 4088, title: "Abort reason lost in the retry helper"}];
		const excluded = rank({tokens, queue, search: [], limit: 20, label: "l", exclude: 999});
		const plain = rank({tokens, queue, search: [], limit: 20, label: "l"});
		expect(excluded).toEqual(plain);
	});

	it("filters nothing when --exclude is absent or null", () => {
		const queue = [{number: 4312, title: "Abort reason lost in the retry helper"}];
		expect(rank({tokens, queue, search: [], limit: 20, label: "l"}).candidates).toHaveLength(1);
		expect(
			rank({tokens, queue, search: [], limit: 20, label: "l", exclude: null}).candidates,
		).toHaveLength(1);
	});

	it("never reports a degenerate query as `none`, even when candidates exist", () => {
		const result = rank({
			tokens: ["thing"],
			queue: [{number: 1, title: "the thing"}],
			search: [],
			limit: 20,
			label: "l",
		});
		expect(result.outcome).toBe("indeterminate");
		expect(result.candidates).toEqual([]);
	});
});

describe("renderCandidate", () => {
	it("is tab-separated with a bare number, so `cut -f1` needs no stripping", () => {
		expect(renderCandidate({number: 4312, source: "both", score: 4, title: "Abort reason"})).toBe(
			"4312\tboth\t4\tAbort reason",
		);
	});
});
