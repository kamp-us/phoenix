/**
 * Unit tests for the FTS backfill core (issue #534) — no DB engine (ADR 0082: a
 * test that boots a SQL engine is not a unit test, and `node:sqlite`'s FTS5 is
 * not D1's, so a faked engine proves nothing about the real index).
 *
 * The statements `buildBackfillStatements` returns are drizzle query builders now
 * (ADR 0080 / #863), not `SQL` — so we drive them through the REAL drizzle-d1
 * `batch()` over a recording D1 *client* (the `fts-sync.unit.test.ts` technique):
 * a builder that isn't batch-preparable throws there, so a regression to a
 * non-batchable item shape (e.g. re-wrapping through `db.run(sql)`) fails here, not
 * only on remote D1. To assert the rendered SQL/params we render each builder's
 * `getSQL()` via `SQLiteSyncDialect`.
 *
 * The load-bearing assertion is that the indexed `norm` equals the worker's OWN
 * `normalizeSearchText(title)` — importing the canonical fold here pins the
 * backfill's index value to the dual-write's (issue #534's hard constraint), so a
 * future fork of the normalization fails this test.
 */
import {createDrizzle} from "@kampus/web/db/Drizzle";
import {normalizeSearchText} from "@kampus/web/features/search/normalize";
import {SQLiteSyncDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {buildBackfillStatements, type SourceRow} from "./backfill.ts";

const dialect = new SQLiteSyncDialect();
const renderStmt = (stmt: {getSQL: () => never}) => dialect.sqlToQuery(stmt.getSQL());

/**
 * A recording D1 *client* — NOT a SQL engine, so this stays a unit test under ADR
 * 0082's "no faked engine" rule: it executes no SQL and asserts no FTS5 behavior.
 * It records only the statements drizzle's real d1 `batch()` builder *prepares and
 * binds* — the exact seam the #863 regression broke (a batch item must `_prepare()`
 * to a `D1PreparedQuery` whose `.stmt` the builder binds params onto).
 */
const recordingD1 = () => {
	const built: {sql: string; params: unknown[]}[] = [];
	const client = {
		prepare(sql: string) {
			return {
				sql,
				bind(...params: unknown[]) {
					return {sql, params, run: () => ({}), raw: () => [], all: () => ({results: []})};
				},
			};
		},
		async batch(stmts: {sql: string; params: unknown[]}[]) {
			for (const s of stmts) built.push({sql: s.sql, params: s.params});
			return stmts.map(() => ({results: [], success: true, meta: {}}));
		},
	};
	// biome-ignore lint/plugin: a recording D1 client (no SQL engine) can't be structurally typed as the full `D1Database` interface; `createDrizzle` only calls `prepare`/`batch`, which it provides.
	const db = createDrizzle(client as unknown as D1Database);
	return {db, built};
};

describe("buildBackfillStatements — replays the ADR-0080 sync over source rows", () => {
	it("emits a DELETE+INSERT pair per term, indexing the worker-normalized title", () => {
		const {db} = recordingD1();
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
		const {db} = recordingD1();
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
		const {db} = recordingD1();
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

	it("renders byte-identical statements on a re-run (idempotent by construction)", () => {
		const {db} = recordingD1();
		const terms: SourceRow[] = [{key: "k", title: "Kâğıt"}];
		const first = buildBackfillStatements(db, terms, []).statements.map((s) =>
			renderStmt(s as never),
		);
		const second = buildBackfillStatements(db, terms, []).statements.map((s) =>
			renderStmt(s as never),
		);
		// Delete-then-insert keyed on the slug: the same input yields the same SQL,
		// so a second run replaces the same FTS row rather than duplicating it.
		expect(second).toEqual(first);
		expect(first[0]?.sql).toMatch(/delete from "term_search"/);
	});

	it("an empty corpus produces no statements (the no-op case)", () => {
		const {db} = recordingD1();
		const {statements, report} = buildBackfillStatements(db, [], []);
		expect(statements).toEqual([]);
		expect(report).toEqual({terms: 0, posts: 0});
	});

	it("the built statements are batch-safe through the REAL d1 batch builder (#863)", async () => {
		const {db, built} = recordingD1();
		const terms: SourceRow[] = [{key: "t", title: "Başlık"}];
		const {statements} = buildBackfillStatements(db, terms, []);
		const [first, ...rest] = statements;
		// Drive the same path the runner does: builders spread straight into batch,
		// never re-wrapped through `db.run(sql)` (the SQLiteRaw that 500'd in #863).
		await expect(db.batch([first as never, ...(rest as never[])])).resolves.toBeDefined();
		expect(built).toHaveLength(2);
		expect(built[0]?.sql).toBe('delete from "term_search" where "term_search"."slug" = ?');
		expect(built[0]?.params).toEqual(["t"]);
		expect(built[1]?.sql).toBe('insert into "term_search" ("slug", "norm") values (?, ?)');
		expect(built[1]?.params).toEqual(["t", normalizeSearchText("Başlık")]);
	});
});
