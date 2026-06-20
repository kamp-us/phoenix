/**
 * Unit tests for the backfill's batch WRITE path — the slice the pure
 * `buildBackfillStatements` test (backfill.unit.test.ts) does not exercise.
 *
 * Two contracts are locked here without CF creds:
 *
 * 1. `backfill()` assembles the FTS write as `prepare(sql).bind(...params)` per
 *    statement + one `D1Database.batch([...])`, in source order with bound params
 *    — driven against a fake in-memory `D1Database`. This is the exact site that
 *    threw on real D1 (PR #645/#890): the prior `db.batch([db.run(SQL)...])` hit a
 *    drizzle 1.0.0-rc.3 defect where `SQLiteRaw._prepare()` returns itself with no
 *    `.stmt` (issue #893). A faithful D1 binding never sees a malformed batch item.
 *
 * 2. `makeD1Rest`'s `prepare`/`bind`/`batch` slice issues ONE REST `query` POST
 *    carrying the whole batch (sql+params, ordered) — driven over a fake
 *    `FetchHttpClient.Fetch` so the REST adapter's real transport runs offline.
 */
import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import {syncTermSearch} from "@kampus/web/features/search/fts-sync";
import {SQLiteAsyncDialect} from "drizzle-orm/sqlite-core";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {describe, expect, it} from "vitest";
import {backfill} from "./backfill.ts";
import {makeD1Rest} from "./d1-rest.ts";

const dialect = new SQLiteAsyncDialect();

/** One recorded statement as it reaches the D1 binding's batch contract. */
interface RecordedStmt {
	readonly sql: string;
	readonly params: ReadonlyArray<unknown>;
}

/**
 * An in-memory `D1Database` honoring the slice the backfill drives: `prepare(sql)`
 * → a stmt with `.bind(...args)` recording params, and `batch([...])` recording the
 * bound statements in order. Reads (`db.select(...)`) flow through drizzle's
 * `prepare(sql).bind(...).all()`, served from the seeded `terms`/`posts`.
 */
const makeFakeD1 = (seed: {terms: {slug: string; title: string}[]}) => {
	const batches: RecordedStmt[][] = [];

	// The backfill's only read is `SELECT slug, title FROM term_summary`; drizzle's
	// d1 select reads it through `.raw()` (array-of-arrays, mapped by column order).
	const isTermRead = (sql: string) => /from\s+["`]?term_summary["`]?/i.test(sql);

	const stmt = (sql: string, params: ReadonlyArray<unknown>) => ({
		sql,
		params,
		bind: (...args: unknown[]) => stmt(sql, args),
		all: async () => ({
			results: isTermRead(sql) ? seed.terms.map((t) => ({slug: t.slug, title: t.title})) : [],
		}),
		run: async () => ({success: true, meta: {}, results: []}),
		raw: async () => (isTermRead(sql) ? seed.terms.map((t) => [t.slug, t.title]) : []),
		first: async () => null,
	});

	// biome-ignore lint/plugin: a test fake implementing only the prepare/bind/batch slice the backfill drives; the full `D1Database` surface can't be built honestly here, so this assembly point widens to it once (same idiom as the makeD1Rest shim under test).
	const db = {
		prepare: (sql: string) => stmt(sql, []),
		batch: async (statements: RecordedStmt[]) => {
			batches.push(statements.map((s) => ({sql: s.sql, params: s.params})));
			return statements.map(() => ({success: true, meta: {}, results: []}));
		},
		exec: async () => ({count: 0, duration: 0}),
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;

	return {db, batches};
};

describe("backfill() — writes the FTS rows as one bound D1 batch", () => {
	it("prepares + binds each statement and batches them in source order", async () => {
		const terms = [
			{slug: "sisli", title: "Şişli Büyük Buluşma"},
			{slug: "istanbul", title: "İstanbul"},
		];
		const {db, batches} = makeFakeD1({terms});

		const report = await backfill(db);

		expect(report).toEqual({terms: 2, posts: 0});

		// One atomic batch carrying the DELETE+INSERT pair per term, in order.
		expect(batches).toHaveLength(1);
		const stmts = batches[0]!;
		expect(stmts).toHaveLength(4);

		// The bound statements are byte-equal to what the dialect renders from the
		// ADR-0080 sync builders — proving prepare/bind carried the params, in order.
		const expected = terms
			.flatMap((t) => syncTermSearch(t.slug, t.title))
			.map((sql) => dialect.sqlToQuery(sql));

		expect(stmts.map((s) => s.sql)).toEqual(expected.map((q) => q.sql));
		expect(stmts.map((s) => s.params)).toEqual(expected.map((q) => q.params));

		// Spot-check the crux: the first INSERT binds [slug, folded-title].
		expect(stmts[0]!.sql).toMatch(/DELETE FROM term_search WHERE slug = \?/);
		expect(stmts[0]!.params).toEqual(["sisli"]);
		expect(stmts[1]!.sql).toMatch(/INSERT INTO term_search \(slug, norm\) VALUES \(\?, \?\)/);
		expect(stmts[1]!.params).toEqual(["sisli", "sisli buyuk bulusma"]);
	});

	it("an empty corpus is a no-op: no batch is issued", async () => {
		const {db, batches} = makeFakeD1({terms: []});
		const report = await backfill(db);
		expect(report).toEqual({terms: 0, posts: 0});
		expect(batches).toHaveLength(0);
	});
});

describe("makeD1Rest — the REST shim's prepare/bind/batch contract", () => {
	it("sends the whole batch as ONE REST query POST, sql+params in order", async () => {
		const requests: {url: string; body: unknown}[] = [];

		const fakeFetch: typeof globalThis.fetch = async (input, init) => {
			const raw = init?.body;
			const text =
				typeof raw === "string"
					? raw
					: raw instanceof Uint8Array
						? new TextDecoder().decode(raw)
						: await new Response(raw as BodyInit).text();
			requests.push({url: String(input), body: text ? JSON.parse(text) : undefined});
			return new Response(JSON.stringify({result: [{meta: {}, results: [], success: true}]}), {
				status: 200,
				headers: {"content-type": "application/json"},
			});
		};

		const layer = Layer.mergeAll(
			FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))),
			// Credentials the REST adapter needs; a token is enough for the shape assertion.
			fromApiToken({apiToken: "test-token"}),
		);

		const d1 = makeD1Rest({accountId: "acc", databaseId: "db", layer});

		const stmts = syncTermSearch("sisli", "Şişli").map((sql) => {
			const {sql: text, params} = dialect.sqlToQuery(sql);
			return d1.prepare(text).bind(...params);
		});
		await d1.batch(stmts);

		// Exactly one REST round-trip carried the whole batch.
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toContain("/d1/database/db/query");
		const body = requests[0]!.body as {batch: {sql: string; params: string[]}[]};
		expect(body.batch).toHaveLength(2);
		expect(body.batch[0]!.sql).toMatch(/DELETE FROM term_search WHERE slug = \?/);
		expect(body.batch[0]!.params).toEqual(["sisli"]);
		expect(body.batch[1]!.sql).toMatch(/INSERT INTO term_search/);
		expect(body.batch[1]!.params).toEqual(["sisli", "sisli"]);
	});
});
