/**
 * Unit tests for the FTS backfill core (issue #534) — no DB engine (ADR 0082: a
 * test that boots a SQL engine is not a unit test, and `node:sqlite`'s FTS5 is
 * not D1's, so a faked engine proves nothing about the real index).
 *
 * The statements `buildBackfillStatements` returns are drizzle query builders (ADR 0080 /
 * #863), rendered here through `SQLiteDialect`. That they survive drizzle-d1's real
 * `batch()` (the #863/#893 regression) is `backfill.batch.unit.test.ts`'s, which drives
 * the runner itself.
 *
 * The load-bearing assertion is that the indexed `norm` equals the worker's OWN
 * `normalizeSearchText(title)` — importing the canonical fold here pins the
 * backfill's index value to the dual-write's (issue #534's hard constraint), so a
 * future fork of the normalization fails this test.
 */
import {createDrizzle} from "@kampus/web/db/Drizzle";
import {normalizeSearchText} from "@kampus/web/features/search/normalize";
import {SQLiteDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {buildBackfillStatements, type SourceRow} from "./backfill.ts";

const dialect = new SQLiteDialect();
const renderStmt = (stmt: {getSQL: () => never}) => dialect.sqlToQuery(stmt.getSQL());

// Statement building never touches the binding, so an inert one is enough (ADR 0082: no
// SQL engine in the unit tier).
// biome-ignore lint/plugin: an inert stand-in can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertDb = () => createDrizzle({} as unknown as D1Database);

describe("buildBackfillStatements — replays the ADR-0080 sync over source rows", () => {
	it("emits a DELETE+INSERT pair per term, indexing the worker-normalized title", () => {
		const db = inertDb();
		const terms: SourceRow[] = [{key: "istanbul", title: "İstanbul"}];
		const {statements, report} = buildBackfillStatements(db, terms, []);

		expect(report).toEqual({terms: 1, posts: 0});
		expect(statements).toHaveLength(2);

		const del = renderStmt(statements[0] as never);
		expect(del.sql).toMatch(/delete from "term_search" where "term_search"."slug" = \?/);
		expect(del.params).toEqual(["istanbul"]);

		const ins = renderStmt(statements[1] as never);
		expect(ins.sql).toMatch(/insert into "term_search" \("slug", "norm"\) values \(\?, \?\)/);
		// The crux: the indexed norm is the worker's own fold, not a local re-spelling.
		expect(ins.params).toEqual(["istanbul", normalizeSearchText("İstanbul")]);
		expect(ins.params[1]).toBe("istanbul");
	});

	it("emits a DELETE+INSERT pair per post, keyed on id", () => {
		const db = inertDb();
		const posts: SourceRow[] = [{key: "post-1", title: "Şişli buluşması"}];
		const {statements, report} = buildBackfillStatements(db, [], posts);

		expect(report).toEqual({terms: 0, posts: 1});
		const del = renderStmt(statements[0] as never);
		expect(del.sql).toMatch(/delete from "post_search" where "post_search"."id" = \?/);
		expect(del.params).toEqual(["post-1"]);

		const ins = renderStmt(statements[1] as never);
		expect(ins.sql).toMatch(/insert into "post_search" \("id", "norm"\) values \(\?, \?\)/);
		expect(ins.params).toEqual(["post-1", normalizeSearchText("Şişli buluşması")]);
		expect(ins.params[1]).toBe("sisli bulusmasi");
	});

	it("interleaves all terms then all posts; report counts the source rows", () => {
		const db = inertDb();
		const terms: SourceRow[] = [
			{key: "a", title: "Alpha"},
			{key: "b", title: "Beta"},
		];
		const posts: SourceRow[] = [{key: "p1", title: "Gamma"}];
		const {statements, report} = buildBackfillStatements(db, terms, posts);

		expect(report).toEqual({terms: 2, posts: 1});
		// 2 stmts/row × 3 rows.
		expect(statements).toHaveLength(6);
		expect(renderStmt(statements[0] as never).sql).toMatch(/term_search/);
		expect(renderStmt(statements[4] as never).sql).toMatch(/post_search/);
	});

	it("an empty corpus produces no statements (the no-op case)", () => {
		const db = inertDb();
		const {statements, report} = buildBackfillStatements(db, [], []);
		expect(statements).toEqual([]);
		expect(report).toEqual({terms: 0, posts: 0});
	});
});
