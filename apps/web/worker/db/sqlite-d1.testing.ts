/**
 * A `node:sqlite`-backed stand-in for the Cloudflare `D1Database` binding.
 *
 * Task 2 proves the fate bridge end-to-end on sozluk, but the integration
 * harness can't load the alchemy worker into workerd yet (that's task 7). So
 * this module gives the node-pool test a *real* SQL engine behind the same D1
 * surface `drizzle-orm/d1` calls — `prepare(sql) → {bind(...params), all(),
 * run(), raw(), first()}` plus `batch([...])` and `exec()`. Drizzle then builds
 * the production `drizzle(d1, {schema})` instance over it, so the worker-level
 * `Drizzle` layer and every Sozluk service method run unmodified against actual
 * SQLite rows.
 *
 * Only the slice of the D1 contract `drizzle-orm/d1` exercises is implemented
 * (see `node_modules/drizzle-orm/d1/session.js`):
 *   - `run()`  → `{success, meta, results}`; `meta` carries the D1 envelope
 *     (`changes`/`last_row_id`) from `node:sqlite`'s `StatementSync.run()`.
 *   - `all()`  → `{results: rowObject[]}`.
 *   - `raw()`  → arrays-of-column-values (one array per row).
 *   - `first()`→ first row object (drizzle uses `all().results[0]`, but D1 also
 *     exposes `first()` directly — provided for completeness).
 *   - `batch(stmts)` → runs each in order inside a SQLite transaction and
 *     returns one `{success, meta, results}` per statement (per-statement
 *     `meta`); a mid-batch failure rolls the whole tuple back (D1's atomic-batch
 *     contract, which the vote write paths depend on).
 *
 * NOT a production artifact — a colocated `*.testing.ts` platform fake (kept out
 * of the vitest unit-test glob by the suffix) never imported by the worker graph.
 */
import {DatabaseSync, type SQLInputValue} from "node:sqlite";
import baselineMigration from "./drizzle/migrations/0000_d1_baseline.sql?raw";

type Params = ReadonlyArray<unknown>;

/**
 * D1's `meta` envelope, the subset the fake populates from `node:sqlite`'s
 * `StatementSync.run()` result. D1's real `meta` (`D1Meta`) carries timing and
 * size fields too; the fake fills only what an in-memory engine can report
 * truthfully — `changes` (rows affected) and `last_row_id` (last INSERT rowid).
 */
interface D1MetaEnvelope {
	changes: number;
	last_row_id: number;
}

interface BoundStub {
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{
		success: true;
		meta: D1MetaEnvelope;
		results: Record<string, unknown>[];
	}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

// A prepared statement is a bound stub (callable with no params — D1 allows
// all()/run()/raw() without a bind, the route drizzle's batch path takes for
// param-less statements) plus the `bind(...params)` entry point.
interface PreparedStub extends BoundStub {
	bind: (...params: Params) => BoundStub;
}

/** Normalize JS values to ones `node:sqlite` accepts as bound params. */
function toSqliteParam(value: unknown): SQLInputValue {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	// D1's contract types params as `unknown`; drizzle only ever binds primitives
	// the sozluk/pano write paths produce (string/number/null/bigint/bytes), which
	// are exactly `SQLInputValue` — narrow the one boundary value here.
	return value as SQLInputValue;
}

export interface SqliteD1 {
	/** The `D1Database`-shaped binding to hand `drizzle(d1, {schema})`. */
	readonly d1: D1Database;
	/** Apply the committed baseline migration SQL (`--> statement-breakpoint`-split). */
	applyMigration: (sql: string) => void;
	/** Tear down the in-memory database. */
	close: () => void;
}

/** Build an in-memory SQLite database fronted by a D1-shaped binding. */
export function makeSqliteD1(): SqliteD1 {
	const db = new DatabaseSync(":memory:");

	// `toSqliteParam` narrows each bound value to `SQLInputValue`, so `bind`
	// is typed with no cast. Read rows come back as `Record<string,
	// SQLOutputValue>` — assignable to `Record<string, unknown>` (an upcast, a
	// single safe `as`). The `raw` path is the exception: `setReturnArrays(true)`
	// changes the runtime row shape to arrays, but `node:sqlite` still types
	// `.all()` as `Record<string, …>[]`, so that one needs the `unknown` hop.
	const bind = (params: Params): SQLInputValue[] => params.map(toSqliteParam);

	// `node:sqlite`'s `StatementSync.run()` returns `{changes, lastInsertRowid}`.
	// `lastInsertRowid` is `number | bigint` (SQLite rowids can exceed 2^53); D1's
	// `meta` types both `changes` and `last_row_id` as `number`, so coerce to the
	// D1 shape. Real rowids in this codebase are small, so the `Number(bigint)`
	// narrowing is lossless in practice and matches D1's number-shaped contract.
	const metaFrom = (result: {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	}): D1MetaEnvelope => ({
		changes: Number(result.changes),
		last_row_id: Number(result.lastInsertRowid),
	});

	const runSql = (sql: string, params: Params): D1MetaEnvelope => {
		const stmt = db.prepare(sql);
		return metaFrom(stmt.run(...bind(params)));
	};
	const allSql = (sql: string, params: Params): Record<string, unknown>[] => {
		const stmt = db.prepare(sql);
		return stmt.all(...bind(params)) as Record<string, unknown>[];
	};
	const rawSql = (sql: string, params: Params): unknown[][] => {
		const stmt = db.prepare(sql);
		stmt.setReturnArrays(true);
		// biome-ignore lint/plugin: `setReturnArrays(true)` makes `.all()` return arrays at runtime, but `node:sqlite` still types it as `Record<string, SQLOutputValue>[]` — the row-shape change isn't expressible in the type, so this boundary needs the hop.
		return stmt.all(...bind(params)) as unknown as unknown[][];
	};

	// D1 `run()` returns `{success, meta, results}`. `results` carries rows when a
	// `SELECT` is run through `.run()` (some service stats recompute reads
	// `r.results[0]` off `db.run(sql\`SELECT ...\`)`); for DML we execute the write
	// and return an empty `results`. Either way `meta` carries the D1 envelope:
	// for DML it's the write's actual `changes`/`last_row_id` (from
	// `StatementSync.run()`); a `SELECT` writes nothing, so its envelope is zeros.
	const runEnvelope = (
		sql: string,
		params: Params,
	): {results: Record<string, unknown>[]; meta: D1MetaEnvelope} => {
		// CAVEAT: this sniff classifies by the leading keyword only — a
		// `WITH ... SELECT` CTE reads as DML (no rows surfaced) and a
		// `... RETURNING` write reads as DML (its returned rows dropped). Both would
		// misclassify, but neither shape appears in the narrow slice drizzle-orm/d1
		// drives here (plain `SELECT` reads, leading-DML writes), so the
		// leading-keyword heuristic is sufficient for the fake.
		if (/^\s*select/i.test(sql)) {
			return {results: allSql(sql, params), meta: {changes: 0, last_row_id: 0}};
		}
		return {results: [], meta: runSql(sql, params)};
	};

	const bound = (sql: string, params: Params): BoundStub => ({
		all: async () => ({results: allSql(sql, params) as never[]}),
		run: async () => {
			const {results, meta} = runEnvelope(sql, params);
			return {success: true, meta, results};
		},
		raw: async () => rawSql(sql, params) as never[],
		first: async () => {
			const rows = allSql(sql, params);
			return (rows[0] as never) ?? null;
		},
	});

	// A prepared statement is the no-param bound stub plus a `bind` that rebinds
	// the same SQL with params — so it reuses `bound(sql, [])` rather than
	// re-spelling the four method bodies.
	const prepare = (sql: string): PreparedStub => ({
		...bound(sql, []),
		bind: (...params: Params) => bound(sql, params),
	});

	// biome-ignore lint/plugin: only the `prepare`/`exec`/`batch`/`dump` slice drizzle-orm/d1 calls is implemented; the full `D1Database` surface can't be built in a fake, so this assembly point widens to it once.
	const d1 = {
		prepare,
		exec: async (sql: string) => {
			db.exec(sql);
			return {count: 0, duration: 0};
		},
		batch: async (statements: BoundStub[]) => {
			// D1's `batch` is ATOMIC — the whole tuple commits or none of it does.
			// The vote write paths rely on this (the score-cache update + the
			// `user_profile.total_karma` bump must land together with the vote row).
			// Model it faithfully with a SQLite transaction: run each statement in
			// order, and on the FIRST failure roll the whole thing back and rethrow,
			// so a mid-batch error leaves no partial write.
			//
			// Each entry is the full `run()` envelope (`{success, meta, results}`):
			// D1's batch returns one `D1Result` per statement, carrying that
			// statement's `meta` (`changes`/`last_row_id`). drizzle-orm/d1's batch
			// path reads `result.results`; the populated `meta` is what makes the
			// per-statement write count observable in-process (the micro-tier the
			// fate wire can never serialize).
			db.exec("BEGIN IMMEDIATE");
			try {
				const out: {success: true; meta: D1MetaEnvelope; results: unknown[]}[] = [];
				for (const stmt of statements) {
					out.push(await stmt.run());
				}
				db.exec("COMMIT");
				return out;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;

	return {
		d1,
		applyMigration: (sql: string) => {
			const statements = sql
				.split("--> statement-breakpoint")
				.map((s) => s.trim())
				.filter(Boolean);
			for (const stmt of statements) {
				try {
					db.exec(stmt);
				} catch (err) {
					// Swallow ONLY the genuinely-idempotent re-apply cases. A
					// `no such table`/`no such index` is a real defect (e.g. a
					// misspelled-table CREATE INDEX or a PK on a missing table) that
					// would otherwise silently drop a constraint the atomicity tests
					// depend on — let those throw.
					const msg = String(err);
					if (!msg.includes("already exists") && !msg.includes("duplicate column")) {
						throw err;
					}
				}
			}
		},
		close: () => db.close(),
	};
}

/**
 * The one-call test-kit factory: a fresh in-memory SQLite D1 with the committed
 * baseline migration already applied and `foreign_keys` forced OFF to match D1's
 * default.
 *
 * This is a **factory, not a shared instance** — each call yields an independent
 * `:memory:` database, so tests never cross-contaminate. It folds the
 * `makeSqliteD1()` + `applyMigration(baseline)` pair that every D1-backed unit
 * test repeated into a single call; the returned {@link SqliteD1} still exposes
 * `d1` (hand to `createDrizzle`), `applyMigration` (for any extra per-test seed
 * SQL), and `close`.
 *
 * `foreign_keys=OFF` is load-bearing, not cosmetic: `node:sqlite`'s
 * `DatabaseSync` defaults the pragma to ON, whereas Cloudflare D1 ships with it
 * OFF. Forcing it OFF here keeps the fake faithful to production so a test never
 * passes (or fails) on an FK constraint D1 wouldn't enforce.
 */
export function makeSqliteTestDb(): SqliteD1 {
	const sqlite = makeSqliteD1();
	// Match D1's default — `node:sqlite` defaults this pragma ON, D1 ships it OFF.
	sqlite.applyMigration("PRAGMA foreign_keys=OFF;");
	sqlite.applyMigration(baselineMigration);
	return sqlite;
}
