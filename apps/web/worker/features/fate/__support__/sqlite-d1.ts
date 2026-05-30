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
 *   - `run()`  → `{success, meta}` (drizzle ignores the body for `db.run`).
 *   - `all()`  → `{results: rowObject[]}`.
 *   - `raw()`  → arrays-of-column-values (one array per row).
 *   - `first()`→ first row object (drizzle uses `all().results[0]`, but D1 also
 *     exposes `first()` directly — provided for completeness).
 *   - `batch(stmts)` → runs each in order, returns `{results}[]` (atomicity is
 *     not modeled; the sozluk write paths under test don't depend on rollback).
 *
 * NOT a production artifact — it lives under `tests/` and is never imported by
 * `worker/`.
 */
import {DatabaseSync, type SQLInputValue} from "node:sqlite";

type Params = ReadonlyArray<unknown>;

interface PreparedStub {
	bind: (...params: Params) => BoundStub;
	// D1 also allows calling all()/run()/raw() with no bind (no-param queries);
	// drizzle's batch path takes that route for param-less statements.
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{
		success: true;
		meta: Record<string, unknown>;
		results: Record<string, unknown>[];
	}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

interface BoundStub {
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{
		success: true;
		meta: Record<string, unknown>;
		results: Record<string, unknown>[];
	}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
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

	const runSql = (sql: string, params: Params) => {
		const stmt = db.prepare(sql);
		return stmt.run(...bind(params));
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
	// `SELECT` is run through `.run()` (some service stats recomputes read
	// `r.results[0]` off `db.run(sql\`SELECT ...\`)`); for DML we execute the write
	// and return an empty `results`.
	const runReturningSql = (sql: string, params: Params): Record<string, unknown>[] => {
		if (/^\s*select/i.test(sql)) return allSql(sql, params);
		runSql(sql, params);
		return [];
	};

	const bound = (sql: string, params: Params): BoundStub => ({
		all: async () => ({results: allSql(sql, params) as never[]}),
		run: async () => ({success: true, meta: {}, results: runReturningSql(sql, params)}),
		raw: async () => rawSql(sql, params) as never[],
		first: async () => {
			const rows = allSql(sql, params);
			return (rows[0] as never) ?? null;
		},
	});

	const prepare = (sql: string): PreparedStub => ({
		bind: (...params: Params) => bound(sql, params),
		all: async () => ({results: allSql(sql, []) as never[]}),
		run: async () => ({success: true, meta: {}, results: runReturningSql(sql, [])}),
		raw: async () => rawSql(sql, []) as never[],
		first: async () => {
			const rows = allSql(sql, []);
			return (rows[0] as never) ?? null;
		},
	});

	// biome-ignore lint/plugin: only the `prepare`/`exec`/`batch`/`dump` slice drizzle-orm/d1 calls is implemented; the full `D1Database` surface can't be built in a fake, so this assembly point widens to it once.
	const d1 = {
		prepare,
		exec: async (sql: string) => {
			db.exec(sql);
			return {count: 0, duration: 0};
		},
		batch: async (statements: BoundStub[]) => {
			// Sequential execution; drizzle reads `{results}` per statement. The
			// sozluk write paths use batch only for atomic vote writes — order is
			// preserved, which is what the re-resolve assertions check.
			const out: {results: unknown[]}[] = [];
			for (const stmt of statements) {
				out.push(await stmt.all());
			}
			return out;
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
					const msg = String(err);
					if (
						!msg.includes("already exists") &&
						!msg.includes("duplicate column") &&
						!msg.includes("no such table") &&
						!msg.includes("no such index")
					) {
						throw err;
					}
				}
			}
		},
		close: () => db.close(),
	};
}
