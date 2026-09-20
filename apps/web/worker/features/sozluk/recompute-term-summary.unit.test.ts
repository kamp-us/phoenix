/** `recomputeTermSummary` — the pure fold deriving a `term_record` row from live definitions. */
import {describe, expect, it} from "vitest";
import {recomputeTermSummary, type TermSummaryDefRow} from "./Sozluk.ts";
import {storedFirstLetter} from "./turkish-alphabet.ts";

const NOW = new Date("2024-06-01T12:00:00.000Z");

const row = (over: Partial<TermSummaryDefRow> & {id: string}): TermSummaryDefRow => ({
	body: "body",
	bodyExcerpt: "excerpt",
	score: 0,
	createdAt: null,
	updatedAt: null,
	...over,
});

describe("recomputeTermSummary", () => {
	it("empty slice → zeroed counts, null top, `now` fallback for the date edges", () => {
		const out = recomputeTermSummary([], "foo-bar", "Foo Bar", NOW);
		expect(out).toEqual({
			slug: "foo-bar",
			title: "Foo Bar",
			firstLetter: "f",
			definitionCount: 0,
			totalScore: 0,
			topDefinitionId: null,
			excerpt: null,
			firstAt: NOW,
			lastEditAt: NOW,
		});
	});

	it("single row → count 1, that row is the top, its dates flow through", () => {
		const created = new Date("2024-01-10T00:00:00.000Z");
		const updated = new Date("2024-02-20T00:00:00.000Z");
		const out = recomputeTermSummary(
			[row({id: "d1", score: 7, bodyExcerpt: "hello", createdAt: created, updatedAt: updated})],
			"hello",
			"Hello",
			NOW,
		);
		expect(out.definitionCount).toBe(1);
		expect(out.totalScore).toBe(7);
		expect(out.topDefinitionId).toBe("d1");
		expect(out.excerpt).toBe("hello");
		expect(out.firstAt).toBe(created);
		expect(out.lastEditAt).toBe(updated);
	});

	it("sums scores and takes `rows[0]` as the top (rows are pre-sorted score desc)", () => {
		const out = recomputeTermSummary(
			[
				row({id: "top", score: 10, bodyExcerpt: "winner"}),
				row({id: "mid", score: 5, bodyExcerpt: "runner-up"}),
				row({id: "low", score: 2, bodyExcerpt: "third"}),
			],
			"term",
			"Term",
			NOW,
		);
		expect(out.totalScore).toBe(17);
		expect(out.topDefinitionId).toBe("top");
		expect(out.excerpt).toBe("winner");
	});

	it("on a tie the caller's row order wins — `rows[0]` is the top, untouched", () => {
		const out = recomputeTermSummary(
			[
				row({id: "first", score: 5, bodyExcerpt: "first"}),
				row({id: "second", score: 5, bodyExcerpt: "second"}),
			],
			"term",
			"Term",
			NOW,
		);
		expect(out.topDefinitionId).toBe("first");
		expect(out.excerpt).toBe("first");
		expect(out.totalScore).toBe(10);
	});

	it("falls back to the body excerpt when the top row has no stored `bodyExcerpt`", () => {
		const out = recomputeTermSummary(
			[row({id: "d1", score: 1, body: "a fresh body", bodyExcerpt: null})],
			"term",
			"Term",
			NOW,
		);
		expect(out.excerpt).toBe("a fresh body");
	});

	it("firstAt is the MIN createdAt; lastEditAt the MAX of updatedAt ?? createdAt", () => {
		const early = new Date("2024-01-01T00:00:00.000Z");
		const mid = new Date("2024-03-01T00:00:00.000Z");
		const late = new Date("2024-05-01T00:00:00.000Z");
		const out = recomputeTermSummary(
			[
				row({id: "a", createdAt: mid, updatedAt: late}),
				row({id: "b", createdAt: early, updatedAt: null}),
				row({id: "c", createdAt: mid, updatedAt: mid}),
			],
			"term",
			"Term",
			NOW,
		);
		expect(out.firstAt).toBe(early);
		expect(out.lastEditAt).toBe(late);
	});

	it("a row with no updatedAt contributes its createdAt to the lastEditAt max", () => {
		const early = new Date("2024-01-01T00:00:00.000Z");
		const late = new Date("2024-09-01T00:00:00.000Z");
		const out = recomputeTermSummary(
			[
				row({id: "a", createdAt: early, updatedAt: early}),
				row({id: "b", createdAt: late, updatedAt: null}),
			],
			"term",
			"Term",
			NOW,
		);
		expect(out.lastEditAt).toBe(late);
	});

	it("all-null dates fall back to `now` for both edges", () => {
		const out = recomputeTermSummary(
			[row({id: "a", createdAt: null, updatedAt: null})],
			"term",
			"Term",
			NOW,
		);
		expect(out.firstAt).toBe(NOW);
		expect(out.lastEditAt).toBe(NOW);
	});

	// The column files a headword under its Turkish letter. It was read off the SLUG, which is
	// the ASCII fold, so `ç ğ ı ö ş ü` could never appear in it at all (#9331).
	it("firstLetter is the headword's Turkish letter, never the ASCII-folded slug's", () => {
		expect(recomputeTermSummary([], "onbellek", "önbellek", NOW).firstLetter).toBe("ö");
		expect(recomputeTermSummary([], "corba", "çorba", NOW).firstLetter).toBe("ç");
		expect(recomputeTermSummary([], "isik", "ışık", NOW).firstLetter).toBe("ı");
	});

	// `I` is the dotless letter's capital and `İ` is `i`'s — the pair ASCII lowercasing gets
	// backwards, and the reason the fold is a shared function rather than `.toLowerCase()`.
	it("folds the Turkish capitals to their own letters, not to the ASCII ones", () => {
		expect(recomputeTermSummary([], "isik", "IŞIK", NOW).firstLetter).toBe("ı");
		expect(recomputeTermSummary([], "isci", "İŞÇİ", NOW).firstLetter).toBe("i");
	});

	it("files a q, w or x headword under its own letter (#9425)", () => {
		expect(recomputeTermSummary([], "qwerty", "qwerty", NOW).firstLetter).toBe("q");
		expect(recomputeTermSummary([], "web", "Web", NOW).firstLetter).toBe("w");
		expect(recomputeTermSummary([], "xml", "XML", NOW).firstLetter).toBe("x");
	});

	// A headword outside the index belongs to no letter page: `/sozluk/harf/3` resolves to no
	// letter and sends the reader home. `""` is that "no letter" in a NOT NULL column.
	it("stores the empty string for a headword the index does not hold", () => {
		expect(recomputeTermSummary([], "3d-baski", "3D baskı", NOW).firstLetter).toBe("");
		expect(recomputeTermSummary([], "dash", "—em dash", NOW).firstLetter).toBe("");
	});

	// The seed derives the same column (`packages/preview-seed/src/fixtures.ts`) and its own
	// test asserts against this same function, so the two producers agree by construction
	// rather than by two hand-kept folds.
	it("routes the derivation through the shared fold the other producers use", () => {
		for (const title of ["önbellek", "ışık", "Zebra", "XML", "3D baskı"]) {
			expect(recomputeTermSummary([], "slug", title, NOW).firstLetter).toBe(
				storedFirstLetter(title),
			);
		}
	});
});
