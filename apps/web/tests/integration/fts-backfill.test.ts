/**
 * fts-backfill → FTS5 MATCH loop on real D1 (#645, the integration-tier proof ADR
 * 0082 §irreducible-integration names for the write→sync→read dual-write loop).
 *
 * `@kampus/fts-backfill`'s pure core is unit-tested (`buildBackfillStatements`,
 * #534) — byte-correct statements against `SQLiteSyncDialect`, no DB. That proves
 * what the backfill *writes*, never that a backfilled row is *findable* by a query
 * that folds the same way on D1's FTS5 (≠ `node:sqlite`'s). This test runs the REAL
 * `backfill()` (the exact function the bin runs, over the same `makeD1RestFromEnv`
 * REST adapter) against this file's real remote D1, then asserts `Search.ts`'s
 * `searchTerms` resolver returns the backfilled row for a Turkish-diacritic-folded
 * query — proving backfill → sync → FTS5 MATCH → bm25 end to end (ADR 0080 folding).
 *
 * The pre-backfill state is constructed, not faked: `seedTerm` writes a real
 * `term_summary` row AND its `term_search` FTS row (the dual-write), then a
 * setup-only `DELETE FROM term_search` removes ONLY the FTS row — leaving exactly
 * the pre-#534 condition (summary present, never indexed). The pre-assertion that
 * search is empty in that state is the non-vacuity guard: it pins that the hit in
 * the post-assertion is the backfill's doing, not a row that was already indexed.
 */
import {backfill, makeD1RestFromEnv} from "@kampus/fts-backfill";
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now();
const SLUG = `fts645-${STAMP}-sisli`;
// A Turkish-diacritic title whose folded form (`sisli buyuk bulusma`) differs from
// the literal — so a match on the folded query proves the backfill indexed the
// app-side `norm`, not the raw title.
const TITLE = "Şişli Büyük Buluşma";
// Folded, diacritic-free; `normalizeSearchText(TITLE)` collapses to this token stream.
const FOLDED_QUERY = "sisli";

beforeAll(async () => {
	await h.signUp(`${SLUG}-author@test.local`, "hunter2hunter2", "yazar");
	// Seed through the public dual-write: a real term_summary row + its term_search
	// FTS row land together.
	await h.seedTerm({
		slug: SLUG,
		title: TITLE,
		definitions: [{authorName: "yazar", body: "Şişli gövde"}],
	});
	// Drop ONLY this term's FTS row, off the worker binding — reconstructing the
	// pre-backfill state (#534): the summary row exists, the FTS index does not.
	await h.execD1("DELETE FROM term_search WHERE slug = ?", [SLUG]);
});

describe("fts-backfill → FTS5 MATCH on real D1 (#645)", () => {
	it("a backfilled term_summary row becomes findable by a diacritic-folded MATCH", async () => {
		// Non-vacuity guard: with the FTS row deleted, the folded query matches
		// nothing — so a hit below can only come from the backfill, never a leftover index.
		const before = await h.fate({
			kind: "list",
			name: "searchTerms",
			args: {query: FOLDED_QUERY},
			select: ["slug", "title"],
		});
		expect(before.ok).toBe(true);
		if (before.ok) {
			const items = (before.data as {items: Array<{node: {slug: string}}>}).items;
			expect(items.some((e) => e.node.slug === SLUG)).toBe(false);
		}

		// Run the REAL backfill over this stage's real D1 — the same `backfill()` the
		// bin invokes, over the same env-credentialed REST adapter (`makeD1RestFromEnv`).
		const d1 = makeD1RestFromEnv(await h.d1Target());
		const report = await backfill(d1);
		// The seeded term is among the rows it re-indexed (other seed-side terms may
		// exist; the backfill scans the whole corpus, so assert ≥ our one row).
		expect(report.terms).toBeGreaterThanOrEqual(1);

		// The loop's payoff: the folded query now MATCHes the backfilled row via the
		// live resolver — backfill → sync → FTS5 MATCH → bm25, proven on real D1.
		const after = await h.fate({
			kind: "list",
			name: "searchTerms",
			args: {query: FOLDED_QUERY},
			select: ["slug", "title"],
		});
		expect(after.ok).toBe(true);
		if (after.ok) {
			const items = (after.data as {items: Array<{node: {slug: string; title: string}}>}).items;
			const hit = items.find((e) => e.node.slug === SLUG);
			expect(hit).toBeDefined();
			expect(hit?.node.title).toBe(TITLE);
		}
	});
});
