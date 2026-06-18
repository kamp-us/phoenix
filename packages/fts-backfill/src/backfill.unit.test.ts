/**
 * Unit tests for the FTS backfill core (issue #534) — pure, no DB (ADR 0082: a
 * test that boots a SQL engine is not a unit test, and `node:sqlite`'s FTS5 is
 * not D1's, so a faked engine proves nothing about the real index). We render the
 * built statements to SQLite text+params via `SQLiteSyncDialect` and assert the
 * actual SQL — the same technique as `apps/web/worker/db/keyset.unit.test.ts`.
 *
 * The load-bearing assertion is that the indexed `norm` equals the worker's OWN
 * `normalizeSearchText(title)` — importing the canonical fold here pins the
 * backfill's index value to the dual-write's (issue #534's hard constraint), so a
 * future fork of the normalization fails this test.
 */
import {normalizeSearchText} from "@kampus/web/features/search/normalize";
import type {SQL} from "drizzle-orm";
import {SQLiteSyncDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {buildBackfillStatements, type SourceRow} from "./backfill.ts";

const dialect = new SQLiteSyncDialect();
const render = (sql: SQL) => dialect.sqlToQuery(sql);

describe("buildBackfillStatements — replays the ADR-0080 sync over source rows", () => {
	it("emits a DELETE+INSERT pair per term, indexing the worker-normalized title", () => {
		const terms: SourceRow[] = [{key: "istanbul", title: "İstanbul"}];
		const {statements, report} = buildBackfillStatements(terms, []);

		expect(report).toEqual({terms: 1, posts: 0});
		expect(statements).toHaveLength(2);

		const del = render(statements[0] as SQL);
		expect(del.sql).toMatch(/DELETE FROM term_search WHERE slug = \?/);
		expect(del.params).toEqual(["istanbul"]);

		const ins = render(statements[1] as SQL);
		expect(ins.sql).toMatch(/INSERT INTO term_search \(slug, norm\) VALUES \(\?, \?\)/);
		// The crux: the indexed norm is the worker's own fold, not a local re-spelling.
		expect(ins.params).toEqual(["istanbul", normalizeSearchText("İstanbul")]);
		expect(ins.params[1]).toBe("istanbul");
	});

	it("emits a DELETE+INSERT pair per post, keyed on id", () => {
		const posts: SourceRow[] = [{key: "post-1", title: "Şişli buluşması"}];
		const {statements, report} = buildBackfillStatements([], posts);

		expect(report).toEqual({terms: 0, posts: 1});
		const del = render(statements[0] as SQL);
		expect(del.sql).toMatch(/DELETE FROM post_search WHERE id = \?/);
		expect(del.params).toEqual(["post-1"]);

		const ins = render(statements[1] as SQL);
		expect(ins.sql).toMatch(/INSERT INTO post_search \(id, norm\) VALUES \(\?, \?\)/);
		expect(ins.params).toEqual(["post-1", normalizeSearchText("Şişli buluşması")]);
		expect(ins.params[1]).toBe("sisli bulusmasi");
	});

	it("interleaves all terms then all posts; report counts the source rows", () => {
		const terms: SourceRow[] = [
			{key: "a", title: "Alpha"},
			{key: "b", title: "Beta"},
		];
		const posts: SourceRow[] = [{key: "p1", title: "Gamma"}];
		const {statements, report} = buildBackfillStatements(terms, posts);

		expect(report).toEqual({terms: 2, posts: 1});
		// 2 stmts/row × 3 rows.
		expect(statements).toHaveLength(6);
		expect(render(statements[0] as SQL).sql).toMatch(/term_search/);
		expect(render(statements[4] as SQL).sql).toMatch(/post_search/);
	});

	it("is idempotent by construction: a re-run renders byte-identical statements", () => {
		const terms: SourceRow[] = [{key: "k", title: "Kâğıt"}];
		const first = buildBackfillStatements(terms, []).statements.map(render);
		const second = buildBackfillStatements(terms, []).statements.map(render);
		// Delete-then-insert keyed on the slug: the same input yields the same SQL,
		// so a second run replaces the same FTS row rather than duplicating it.
		expect(second).toEqual(first);
		expect(first[0]?.sql).toMatch(/DELETE FROM term_search/);
	});

	it("an empty corpus produces no statements (the no-op case)", () => {
		const {statements, report} = buildBackfillStatements([], []);
		expect(statements).toEqual([]);
		expect(report).toEqual({terms: 0, posts: 0});
	});
});
