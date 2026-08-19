/**
 * FTS dual-write sync coverage (ADR 0080) — the write/query fold symmetry, the
 * delete-then-insert upsert shape, and batch-safety against drizzle's REAL d1 batch
 * builder. That last one matters because a sync item that prepares without a bound
 * `.stmt` 500s the whole batch on real D1, and a recording-`db.run` fake never reaches
 * the builder path where that shows up (#863).
 */

import {SQLiteDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb} from "../../db/Drizzle.ts";
import {removePostSearch, removeTermSearch, syncPostSearch, syncTermSearch} from "./fts-sync";
import {normalizeSearchText} from "./normalize";

const dialect = new SQLiteDialect();
const renderStmt = (stmt: {getSQL: () => never}) => dialect.sqlToQuery(stmt.getSQL());

/**
 * A recording D1 *client*, NOT a SQL engine — it executes nothing and asserts no
 * FTS5/tokenizer/collation behavior, so this stays a unit test under ADR 0082. It
 * records what drizzle's real `batch()` builder prepares and binds, which is the seam
 * the #863 regression broke.
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
		const items = syncTermSearch(db as DrizzleDb, "t", "Başlık");
		await expect(db.batch([items[0], items[1]] as never)).resolves.toBeDefined();
		expect(built).toHaveLength(2);
		expect(built[0]?.sql).toBe('delete from "term_search" where "term_search"."slug" = ?');
		expect(built[0]?.params).toEqual(["t"]);
		expect(built[1]?.sql).toBe('insert into "term_search" ("slug", "norm") values (?, ?)');
		expect(built[1]?.params).toEqual(["t", normalizeSearchText("Başlık")]);
	});

	it("a parametrized db.run(sql) item is batch-safe under drizzle rc.4 (the #863 rc.3 defect, fixed upstream)", async () => {
		const {db, built} = recordingD1();
		const {sql} = await import("drizzle-orm");
		// The rc.3 defect: `db.run(sql)` prepared without a `.stmt`, so the batch builder
		// threw on a parametrized item. rc.4's `prepareQuery` always prepares one, so this
		// pins the upstream fix we now depend on.
		const raw = db.run(sql`INSERT INTO term_search (slug, norm) VALUES (${"t"}, ${"n"})`);
		await expect(db.batch([raw] as never)).resolves.toBeDefined();
		expect(built).toHaveLength(1);
		expect(built[0]?.params).toEqual(["t", "n"]);
	});

	it("folds a single-statement removal (delete path) into one batch item", async () => {
		const {db, built} = recordingD1();
		const removal = removePostSearch(db as DrizzleDb, "post_1");
		await expect(db.batch([removal] as never)).resolves.toBeDefined();
		expect(built).toHaveLength(1);
		expect(built[0]?.sql).toBe('delete from "post_search" where "post_search"."id" = ?');
		expect(built[0]?.params).toEqual(["post_1"]);
		expect(renderStmt(removeTermSearch(db as DrizzleDb, "t") as never).sql).toBe(
			'delete from "term_search" where "term_search"."slug" = ?',
		);
	});
});
