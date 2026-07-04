/**
 * `Search.searchPosts` hydrates through the SHARED pano mapper, so a post tagged
 * with a legacy seed-era alias (`show`) renders the canonical Turkish label
 * (`göster`) in search — exactly as the feed does (#2015). Before the fix, the
 * search hydrator kept a private `parsePostTags` that set `label = kind` (the raw
 * value), so `show` rendered as `show` in search while `tagLabel` resolved it to
 * `göster` everywhere else — a real user-visible drift. Routing the hydrate through
 * `toPostSummaryKeysetRow` (which calls `parseTags` → `tagLabel`) is the fix; this
 * test is the drift regression, asserting the resolved label off the real service.
 *
 * Driven over a recording D1 *client* (no SQL engine, ADR 0082) that returns a
 * single matching post row carrying `tags: "show"`, so the service runs the real
 * hydrate and shapes the row through the shared mapper.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb, makeDrizzleLayer} from "../../db/Drizzle.ts";
import {Search, SearchLive} from "./Search.ts";

const POST_ID = "post-1";

/**
 * A recording D1 client that answers each query shape the searchPosts read issues:
 * the `count(*)` (1 match), the keyset keys fetch (one key = POST_ID), and the
 * hydrate select (one `post_record` row tagged with the legacy `show` alias). The
 * cursor-rank query never runs (no `after`).
 */
const taggedPostD1 = (tagsCsv: string) => {
	// The hydrate row, in the exact select-column order the searchPosts hydrate lists
	// (id, slug, title, url, host, bodyExcerpt, authorId, authorName, score,
	// commentCount, createdAt, tags) — drizzle's d1 select reads it column-mode via
	// `.raw()`, so it's returned as a value array in that order.
	const hydrateRow = [
		POST_ID,
		"a-post",
		"A Post",
		"https://example.com",
		"example.com",
		"",
		"u1",
		"umut",
		1,
		0,
		0,
		tagsCsv,
	];
	const isHydrate = (sql: string) =>
		/from\s+"post_record"/i.test(sql) && / as key /i.test(sql) === false;
	const answer = (sql: string): {results: unknown[]} => {
		if (/count\(\*\)/i.test(sql)) return {results: [{n: 1}]};
		// keyset keys fetch: `SELECT id AS key ... ORDER BY ... LIMIT`
		if (/ as key /i.test(sql)) return {results: [{key: POST_ID}]};
		return {results: []};
	};
	const stmt = {
		_sql: "",
		bind() {
			return stmt;
		},
		async all() {
			return answer(stmt._sql);
		},
		async run() {
			return {...answer(stmt._sql), success: true, meta: {}};
		},
		async raw() {
			// drizzle's d1 `.select()` reads column-mode via `.raw()` (arrays of values).
			return isHydrate(stmt._sql) ? [hydrateRow] : [];
		},
		async first() {
			return null;
		},
	};
	const client = {
		prepare(sql: string) {
			stmt._sql = sql;
			return stmt;
		},
		async batch(stmts: unknown[]) {
			return stmts.map(() => ({results: [], success: true, meta: {}}));
		},
	};
	// biome-ignore lint/plugin: a recording D1 client (no SQL engine) can't be structurally typed as the full `D1Database`; the d1 driver only calls `prepare`/`batch`.
	const db = createDrizzle(client as unknown as D1Database);
	return db;
};

const searchOnePost = async (tagsCsv: string) => {
	const db = taggedPostD1(tagsCsv);
	const layer = SearchLive.pipe(Layer.provide(makeDrizzleLayer(db as DrizzleDb)));
	return Effect.runPromise(
		Effect.gen(function* () {
			const search = yield* Search;
			return yield* search.searchPosts({query: "post"});
		}).pipe(Effect.provide(layer)),
	);
};

describe("searchPosts — tags render the canonical label via the shared mapper (#2015)", () => {
	it("resolves the legacy `show` alias to the canonical `göster` label, matching the feed", async () => {
		const page = await searchOnePost("show");
		expect(page.rows).toHaveLength(1);
		const tags = page.rows[0]?.tags;
		expect(tags).toEqual([{kind: "show", label: "göster"}]);
	});

	it("leaves a canonical Turkish kind (`göster`) as its own label", async () => {
		const page = await searchOnePost("göster");
		expect(page.rows[0]?.tags).toEqual([{kind: "göster", label: "göster"}]);
	});
});
