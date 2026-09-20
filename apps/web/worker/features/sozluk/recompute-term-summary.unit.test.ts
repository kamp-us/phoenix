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
	it("empty slice → zeroed counts, null top, the fallback for every date edge", () => {
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
			lastActivityAt: NOW,
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

/**
 * `last_activity_at` is the lead column of the public `recent` order. It used to be written
 * from the caller's clock, so the 6-hourly reconcile sweep re-dated every term and the
 * homepage read every headword as at most six hours old (#9540). Every `fallback` here is a
 * fixed `Date` and every pair of calls uses two DIFFERENT ones, so no assertion below can
 * pass by two calls landing in the same millisecond.
 */
describe("recomputeTermSummary — lastActivityAt is content, not a clock (#9540)", () => {
	const CREATED = new Date("2024-01-10T00:00:00.000Z");
	const EDITED = new Date("2024-03-05T00:00:00.000Z");
	const LATER_SWEEP = new Date("2024-09-09T09:09:09.000Z");
	const defs = [row({id: "d1", score: 3, createdAt: CREATED, updatedAt: EDITED})];

	it("is the newest `updatedAt ?? createdAt` across the live slice", () => {
		const older = row({id: "d0", createdAt: CREATED, updatedAt: CREATED});
		const out = recomputeTermSummary([older, ...defs], "term", "Term", NOW);
		expect(out.lastActivityAt).toBe(EDITED);
	});

	it("a reconcile pass over unchanged definitions leaves it unchanged", () => {
		const first = recomputeTermSummary(defs, "term", "Term", NOW);
		const second = recomputeTermSummary(defs, "term", "Term", LATER_SWEEP);
		expect(NOW.getTime()).not.toBe(LATER_SWEEP.getTime());
		expect(second.lastActivityAt).toEqual(first.lastActivityAt);
		expect(second.lastActivityAt).toBe(EDITED);
	});

	it("never takes the caller's clock while any definition row exists", () => {
		for (const fallback of [NOW, LATER_SWEEP]) {
			const out = recomputeTermSummary(defs, "term", "Term", fallback);
			expect(out.lastActivityAt).not.toEqual(fallback);
		}
	});

	it("a new definition with a later `createdAt` raises it to that instant", () => {
		const added = new Date("2024-06-01T00:00:00.000Z");
		const out = recomputeTermSummary(
			[...defs, row({id: "d2", createdAt: added, updatedAt: null})],
			"term",
			"Term",
			NOW,
		);
		expect(out.lastActivityAt).toBe(added);
	});

	it("raising an existing row's `updatedAt` raises it to that instant", () => {
		const reEdited = new Date("2024-07-02T00:00:00.000Z");
		const out = recomputeTermSummary(
			[row({id: "d1", score: 3, createdAt: CREATED, updatedAt: reEdited})],
			"term",
			"Term",
			NOW,
		);
		expect(out.lastActivityAt).toBe(reEdited);
	});

	// The write site hands the stored row's own `first_at` in as the fallback, so an empty
	// term folds to the instant it already carries instead of advancing to the sweep's clock.
	it("an empty term reports the fallback — the stored `first_at` at the write site", () => {
		const storedFirstAt = new Date("2023-11-11T11:11:11.000Z");
		const out = recomputeTermSummary([], "bos", "boş", storedFirstAt);
		expect(out.lastActivityAt).toBe(storedFirstAt);
		expect(out.firstAt).toBe(storedFirstAt);
		expect(out.lastEditAt).toBe(storedFirstAt);
	});
});
