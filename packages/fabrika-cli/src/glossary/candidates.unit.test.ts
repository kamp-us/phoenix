import {describe, expect, it} from "vitest";
import {compareBytes, phrasesOf, rankCandidates, survivesFilter, tokenize} from "./candidates.ts";

const commit = (sha: string, subject: string, body = "") => ({sha, subject, body});

describe("tokenize", () => {
	// v1's tokenizer was `/\b[a-z][a-z-]+\b/g`, so every Turkish product noun was invisible (#4481).
	it("keeps Unicode letters, so a Turkish noun is a token", () => {
		expect(tokenize("sözlük ve geçit")).toEqual(["sözlük", "ve", "geçit"]);
	});

	it("keeps hyphens and underscores inside a token and splits on everything else", () => {
		expect(tokenize("front-door, capture_ledger (v2)")).toEqual([
			"front-door",
			"capture_ledger",
			"v2",
		]);
	});
});

describe("phrasesOf", () => {
	it("takes every quoted and backticked span, from the subject and the body", () => {
		const phrases = phrasesOf(commit("a", 'add "front door" routing', "see `capture ledger`"));
		expect(phrases).toContain("front door");
		expect(phrases).toContain("capture ledger");
	});

	it("takes the subject's 2- and 3-grams, and not the body's", () => {
		const phrases = phrasesOf(commit("a", "add capture ledger", "body words here"));
		expect(phrases).toContain("add capture");
		expect(phrases).toContain("add capture ledger");
		expect(phrases).not.toContain("body words");
	});
});

describe("survivesFilter", () => {
	it("drops a phrase whose every token is a stopword", () => {
		expect(survivesFilter("and the", new Set())).toBe(false);
	});

	it("drops a phrase carrying a short token that is not itself declared", () => {
		expect(survivesFilter("do the thing", new Set())).toBe(false);
	});

	it("keeps a short token that IS a declared key", () => {
		expect(survivesFilter("do the thing", new Set(["do"]))).toBe(true);
	});
});

describe("rankCandidates", () => {
	const declared = new Set(["capture ledger"]);

	/**
	 * The measured v1 defect: it suppressed a candidate when a declared term contained it **or** it
	 * contained a declared term, which against a 226-row register left about 10% precision (#4481).
	 * Suppression here is equality on the normalized key and nothing else.
	 */
	it("suppresses only an exact key match, never a containment in either direction", () => {
		const ranked = rankCandidates(
			[commit("a", 'add "capture ledger" and "capture ledger rotation"')],
			declared,
			40,
		);
		expect(ranked.map((candidate) => candidate.phrase)).toContain("capture ledger rotation");
		expect(ranked.map((candidate) => candidate.phrase)).not.toContain("capture ledger");
	});

	it("orders by hits descending, then by the phrase byte-wise", () => {
		const ranked = rankCandidates(
			[
				commit("a", 'add "retry budget"'),
				commit("b", 'tune "retry budget"'),
				commit("c", 'add "zebra crossing" and "alpha channel"'),
			],
			new Set(),
			40,
		);
		expect(ranked[0]?.phrase).toBe("retry budget");
		expect(ranked[0]?.hits).toBe(2);
		const rest = ranked.slice(1).map((candidate) => candidate.phrase);
		expect(rest.indexOf("alpha channel")).toBeLessThan(rest.indexOf("zebra crossing"));
	});

	it("names the EARLIEST contributing commit, which is where the surface is read from", () => {
		const ranked = rankCandidates(
			[commit("older", 'add "retry budget"'), commit("newer", 'tune "retry budget"')],
			new Set(),
			40,
		);
		expect(ranked[0]?.firstCommit).toBe("older");
	});

	it("honours --limit", () => {
		const ranked = rankCandidates(
			[commit("a", "add capture ledger rotation policy")],
			new Set(),
			2,
		);
		expect(ranked).toHaveLength(2);
	});
});

describe("compareBytes", () => {
	it("orders by UTF-8 bytes rather than by a locale", () => {
		expect(compareBytes("a", "b")).toBeLessThan(0);
		expect(compareBytes("z", "ö")).toBeLessThan(0);
	});
});
