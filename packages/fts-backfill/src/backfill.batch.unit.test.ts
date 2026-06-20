/**
 * Unit tests for the backfill's batch WRITE path — the slice the pure
 * `buildBackfillStatements` test (backfill.unit.test.ts) does not exercise.
 *
 * Two contracts are locked here without CF creds:
 *
 * 1. `backfill()` drives the FTS write as drizzle's real d1 `batch()` over a fake
 *    `D1Database` — which `prepare(sql).bind(...params)` per statement and issues
 *    ONE `D1Database.batch([...])`, in source order with bound params. The
 *    statements are ADR-0080 drizzle BUILDERS now (ADR 0080 / #863), so what the
 *    fake records is the drizzle-rendered SQL; re-wrapping a builder through
 *    `db.run(sql)` would yield a `SQLiteRaw` with no `.stmt` and 500 the batch
 *    (issue #893) — exactly the regression this path guards.
 * 2. `makeD1Rest`'s `prepare`/`bind`/`batch` slice issues ONE REST `query` POST
 *    carrying the whole batch (sql+params, ordered) — driven over a fake
 *    `FetchHttpClient.Fetch` so the REST adapter's real transport runs offline.
 */
import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import {createDrizzle, type DrizzleDb} from "@kampus/web/db/Drizzle";
import {syncTermSearch} from "@kampus/web/features/search/fts-sync";
import {SQLiteSyncDialect} from "drizzle-orm/sqlite-core";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {describe, expect, it} from "vitest";
import {backfill} from "./backfill.ts";
import {makeD1Rest} from "./d1-rest.ts";

const dialect = new SQLiteSyncDialect();
const renderStmt = (stmt: {getSQL: () => never}) => dialect.sqlToQuery(stmt.getSQL());

/** One recorded statement as it reaches the D1 binding's batch contract. */
interface RecordedStmt {
	readonly sql: string;
	readonly params: ReadonlyArray<unknown>;
}

/**
 * An in-memory `D1Database` honoring the slice the backfill drives: `prepare(sql)`
 * → a stmt with `.bind(...args)` recording params, and `batch([...])` recording the
 * bound statements in order. Reads (`db.select(...)`) flow through drizzle's
 * `prepare(sql).bind(...).all()`, served from the seeded `terms`.
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
		// ADR-0080 sync BUILDERS — proving prepare/bind carried the params, in order.
		// A throwaway drizzle db renders the same builders the backfill batched.
		const rdb = createDrizzle(db) as DrizzleDb;
		const expected = terms
			.flatMap((t) => syncTermSearch(rdb, t.slug, t.title))
			.map((s) => renderStmt(s as never));

		expect(stmts.map((s) => s.sql)).toEqual(expected.map((q) => q.sql));
		expect(stmts.map((s) => s.params)).toEqual(expected.map((q) => q.params));

		// Spot-check the crux: the first INSERT binds [slug, folded-title].
		expect(stmts[0]!.sql).toBe('delete from "term_search" where "term_search"."slug" = ?');
		expect(stmts[0]!.params).toEqual(["sisli"]);
		expect(stmts[1]!.sql).toBe('insert into "term_search" ("slug", "norm") values (?, ?)');
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

		// Build the batch the way the backfill does: drizzle BUILDERS over the REST
		// shim, spread straight into the drizzle `batch()` (which prepare/binds each).
		const rdb = createDrizzle(d1) as DrizzleDb;
		const [first, second] = syncTermSearch(rdb, "sisli", "Şişli");
		await rdb.batch([first, second]);

		// Exactly one REST round-trip carried the whole batch.
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toContain("/d1/database/db/query");
		const body = requests[0]!.body as {batch: {sql: string; params: string[]}[]};
		expect(body.batch).toHaveLength(2);
		expect(body.batch[0]!.sql).toBe('delete from "term_search" where "term_search"."slug" = ?');
		expect(body.batch[0]!.params).toEqual(["sisli"]);
		expect(body.batch[1]!.sql).toBe('insert into "term_search" ("slug", "norm") values (?, ?)');
		expect(body.batch[1]!.params).toEqual(["sisli", "sisli"]);
	});

	// #940: `run()` once hardcoded `meta: {}`, dropping D1's row-change count — latent
	// here (no consumer reads it), but it bit moderator-grant's setRole (#937). Lock the
	// REST `result: [{ meta: { changes } }]` → `meta.changes` mapping so it can't regress.
	it("run() carries D1's row-change count from the REST meta (#937/#940)", async () => {
		const fakeFetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({result: [{meta: {changes: 3}, results: [], success: true}]}), {
				status: 200,
				headers: {"content-type": "application/json"},
			});

		const layer = Layer.mergeAll(
			FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))),
			fromApiToken({apiToken: "test-token"}),
		);
		const d1 = makeD1Rest({accountId: "acc", databaseId: "db", layer});

		const res = await d1
			.prepare("update term_search set norm = ? where slug = ?")
			.bind("x", "y")
			.run();

		expect(res.meta.changes).toBe(3);
	});

	it("run() defaults meta.changes to 0 when the REST response carries none", async () => {
		const fakeFetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({result: [{results: [], success: true}]}), {
				status: 200,
				headers: {"content-type": "application/json"},
			});

		const layer = Layer.mergeAll(
			FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))),
			fromApiToken({apiToken: "test-token"}),
		);
		const d1 = makeD1Rest({accountId: "acc", databaseId: "db", layer});

		const res = await d1
			.prepare("update term_search set norm = ? where slug = ?")
			.bind("x", "y")
			.run();

		expect(res.meta.changes).toBe(0);
	});
});
