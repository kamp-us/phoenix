/**
 * T0 unit tests for the FTS dual-write sync (ADR 0080) — no workerd. Pins three
 * invariants the live write→sync→read loop depends on:
 *
 *  1. The symmetric write/query fold: the `norm` text written into the FTS row
 *     folds the SAME way `normalizeSearchText` folds the resolver's query string,
 *     so a write and a later query meet on one token form.
 *  2. The statement shape: each sync is a delete-then-insert upsert (FTS5 has no
 *     `ON CONFLICT`), keyed by slug/id.
 *  3. Batch-safety against drizzle's REAL d1 batch builder (#863): the sync items
 *     must `_prepare()` to a `D1PreparedQuery` carrying a bound `.stmt`, so D1's
 *     `session.batch()` (`preparedQuery.stmt.bind(...params)`) builds them without
 *     throwing. The earlier `db.run(sql\`…\`)` shape yields a `SQLiteRaw` with no
 *     `.stmt`, which 500s the whole batch on real D1 — the prior unit fake (a
 *     recording `db.run`) never reached that builder path, so it sailed past. This
 *     test drives the real drizzle-d1 `batch()` over a recording D1 *client* (no
 *     SQL engine — ADR 0082), so a regression to a non-batchable item shape fails
 *     here, not only in remote integration.
 */

import {SQLiteSyncDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb} from "../../db/Drizzle.ts";
import {removePostSearch, removeTermSearch, syncPostSearch, syncTermSearch} from "./fts-sync";
import {normalizeSearchText} from "./normalize";

const dialect = new SQLiteSyncDialect();
const renderStmt = (stmt: {getSQL: () => never}) => dialect.sqlToQuery(stmt.getSQL());

/**
 * A recording D1 *client* — NOT a SQL engine, so this stays a unit test under ADR
 * 0082's "no faked engine" rule: it executes no SQL and asserts no FTS5/tokenizer/
 * collation behavior (those remain integration-tier facts). It records only the
 * statements drizzle's real d1 `batch()` builder *prepares and binds*, which is the
 * exact seam the #863 regression broke: a batch item must `_prepare()` to a
 * `D1PreparedQuery` whose `.stmt` the builder binds params onto. A query-builder
 * item has that `.stmt`; a `db.run(sql\`…\`)` `SQLiteRaw` does not, so the builder
 * throws before recording. The earlier recording-`db.run` fake never reached this
 * driver path, which is why the break sailed past unit and only 500'd on real D1.
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

describe("syncTermSearch / syncPostSearch — symmetric write/query fold", () => {
	it("writes the SAME folded norm the query side folds with (term)", () => {
		const {db} = recordingD1();
		const title = "İstanbul Şişli";
		const [, insert] = syncTermSearch(db as DrizzleDb, "istanbul-sisli", title);
		const {sql, params} = renderStmt(insert as never);
		expect(sql).toBe('insert into "term_search" ("slug", "norm") values (?, ?)');
		// the indexed text === what the resolver's query fold produces for the same input
		expect(params).toEqual(["istanbul-sisli", normalizeSearchText(title)]);
		expect(params[1]).toBe("istanbul sisli");
	});

	it("writes the SAME folded norm the query side folds with (post)", () => {
		const {db} = recordingD1();
		const title = "Yazılım Mühendisliği";
		const [, insert] = syncPostSearch(db as DrizzleDb, "post_1", title);
		const {params} = renderStmt(insert as never);
		expect(params).toEqual(["post_1", normalizeSearchText(title)]);
		expect(params[1]).toBe("yazilim muhendisligi");
	});

	it("upsert is delete-then-insert keyed by id/slug (FTS5 has no ON CONFLICT)", () => {
		const {db} = recordingD1();
		const [del, insert] = syncPostSearch(db as DrizzleDb, "post_1", "Foo");
		expect(renderStmt(del as never).sql).toBe(
			'delete from "post_search" where "post_search"."id" = ?',
		);
		expect(renderStmt(del as never).params).toEqual(["post_1"]);
		expect(renderStmt(insert as never).sql).toBe(
			'insert into "post_search" ("id", "norm") values (?, ?)',
		);
	});
});

describe("ftsBatchItems shape — batch-safe against D1's real batch builder (#863)", () => {
	it("composes the term sync into a single all-or-none D1 batch WITHOUT throwing", async () => {
		const {db, built} = recordingD1();
		// Build the batch tuple the way Sozluk/Pano now do (no `db.run(sql)` items),
		// run through the REAL drizzle-d1 `batch()` (which binds params onto `.stmt`).
		const items = syncTermSearch(db as DrizzleDb, "t", "Başlık");
		await expect(db.batch([items[0], items[1]] as never)).resolves.toBeDefined();
		// the FTS delete+insert reached D1's batch (params bound, not dropped)
		expect(built).toHaveLength(2);
		expect(built[0]?.sql).toBe('delete from "term_search" where "term_search"."slug" = ?');
		expect(built[0]?.params).toEqual(["t"]);
		expect(built[1]?.sql).toBe('insert into "term_search" ("slug", "norm") values (?, ?)');
		expect(built[1]?.params).toEqual(["t", normalizeSearchText("Başlık")]);
	});

	it("a parametrized db.run(sql) item is NOT batch-safe (the #863 regression it guards)", async () => {
		const {db} = recordingD1();
		const {sql} = await import("drizzle-orm");
		// db.run(sql) yields a SQLiteRaw whose _prepare() has no `.stmt`; D1's batch
		// builder throws on `preparedQuery.stmt.bind(...)` for a parametrized item.
		const raw = db.run(sql`INSERT INTO term_search (slug, norm) VALUES (${"t"}, ${"n"})`);
		await expect(db.batch([raw] as never)).rejects.toThrow();
	});

	it("folds a single-statement removal (delete path) into one batch item", async () => {
		const {db, built} = recordingD1();
		const removal = removePostSearch(db as DrizzleDb, "post_1");
		await expect(db.batch([removal] as never)).resolves.toBeDefined();
		expect(built).toHaveLength(1);
		expect(built[0]?.sql).toBe('delete from "post_search" where "post_search"."id" = ?');
		expect(built[0]?.params).toEqual(["post_1"]);
		// removeTermSearch mirrors it for the term side
		expect(renderStmt(removeTermSearch(db as DrizzleDb, "t") as never).sql).toBe(
			'delete from "term_search" where "term_search"."slug" = ?',
		);
	});
});
