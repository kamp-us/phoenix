/**
 * T0 unit tests for the FTS dual-write sync (ADR 0080) — no workerd. Pins two
 * invariants the live write→sync→read loop depends on:
 *
 *  1. The symmetric write/query fold: the `norm` text written into the FTS row
 *     folds the SAME way `normalizeSearchText` folds the resolver's query string,
 *     so a write and a later query meet on one token form.
 *  2. The atomicity shape: `ftsBatchItems` folds the delete+insert sync `SQL[]`
 *     into batch items 1:1 and in order, so a caller composes them — alongside its
 *     summary write — into ONE `Drizzle.batch` (all-or-none). The summary row and
 *     its FTS row can never drift out of lockstep.
 */

import type {SQL} from "drizzle-orm";
import {SQLiteSyncDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {ftsBatchItems, removePostSearch, syncPostSearch, syncTermSearch} from "./fts-sync";
import {normalizeSearchText} from "./normalize";

const dialect = new SQLiteSyncDialect();
const render = (sql: SQL) => dialect.sqlToQuery(sql);

describe("syncTermSearch / syncPostSearch — symmetric write/query fold", () => {
	it("writes the SAME folded norm the query side folds with (term)", () => {
		const title = "İstanbul Şişli";
		const [, insert] = syncTermSearch("istanbul-sisli", title);
		const {sql, params} = render(insert);
		expect(sql).toBe("INSERT INTO term_search (slug, norm) VALUES (?, ?)");
		// the indexed text === what the resolver's query fold produces for the same input
		expect(params).toEqual(["istanbul-sisli", normalizeSearchText(title)]);
		expect(params[1]).toBe("istanbul sisli");
	});

	it("writes the SAME folded norm the query side folds with (post)", () => {
		const title = "Yazılım Mühendisliği";
		const [, insert] = syncPostSearch("post_1", title);
		const {params} = render(insert);
		expect(params).toEqual(["post_1", normalizeSearchText(title)]);
		expect(params[1]).toBe("yazilim muhendisligi");
	});

	it("upsert is delete-then-insert keyed by id/slug (FTS5 has no ON CONFLICT)", () => {
		const [del, insert] = syncPostSearch("post_1", "Foo");
		expect(render(del).sql).toBe("DELETE FROM post_search WHERE id = ?");
		expect(render(del).params).toEqual(["post_1"]);
		expect(render(insert).sql).toBe("INSERT INTO post_search (id, norm) VALUES (?, ?)");
	});
});

describe("ftsBatchItems — atomicity shape (one batch, all-or-none)", () => {
	// A fake `db.run` recording every statement it was handed and returning a
	// tagged marker, so we can assert the fold is 1:1, ordered, and lossless —
	// i.e. exactly composable into a single Drizzle.batch tuple.
	const fakeDb = () => {
		const seen: SQL[] = [];
		const db = {
			run: (stmt: SQL) => {
				seen.push(stmt);
				return {__item: seen.length - 1} as never;
			},
		};
		return {db, seen};
	};

	it("folds each sync SQL into exactly one batch item, in order", () => {
		const {db, seen} = fakeDb();
		const statements = syncPostSearch("post_1", "Foo");
		const items = ftsBatchItems(db, statements);

		// one item per statement → no statement dropped, none duplicated
		expect(items).toHaveLength(statements.length);
		// every item came from a db.run call (the batchable runner), in source order
		expect(seen).toEqual(statements);
	});

	it("composes summary write + sync into a single all-or-none batch tuple", () => {
		const {db, seen} = fakeDb();
		const summaryWrite = {__summary: true} as never;
		// the call-site shape: [summaryWrite, ...ftsBatchItems(db, sync)] is ONE batch
		const batch = [summaryWrite, ...ftsBatchItems(db, syncTermSearch("t", "Başlık"))];

		// the FTS delete+insert ride in the SAME tuple as the summary write
		expect(batch).toHaveLength(3);
		expect(batch[0]).toBe(summaryWrite);
		// both FTS statements were folded (none left to run separately, outside the batch)
		expect(seen).toEqual(syncTermSearch("t", "Başlık"));
	});

	it("folds a single-statement removal (delete path) into one batch item", () => {
		const {db, seen} = fakeDb();
		const removal = removePostSearch("post_1");
		const items = ftsBatchItems(db, [removal]);
		expect(items).toHaveLength(1);
		expect(seen).toEqual([removal]);
		expect(render(removal).sql).toBe("DELETE FROM post_search WHERE id = ?");
	});
});
