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
import {DatabaseSync} from "node:sqlite";

type Params = ReadonlyArray<unknown>;

interface PreparedStub {
	bind: (...params: Params) => BoundStub;
	// D1 also allows calling all()/run()/raw() with no bind (no-param queries);
	// drizzle's batch path takes that route for param-less statements.
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{success: true; meta: Record<string, unknown>}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

interface BoundStub {
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{success: true; meta: Record<string, unknown>}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

/** Normalize JS values to ones `node:sqlite` accepts as bound params. */
function toSqliteParam(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
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

	// `node:sqlite` types params as `SQLInputValue` and rows as
	// `SQLOutputValue`; the D1 contract is `unknown`-shaped, so the bound values
	// and the read rows cross the boundary through a single cast each.
	const bind = (params: Params) =>
		params.map(toSqliteParam) as unknown as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;

	const runSql = (sql: string, params: Params) => {
		const stmt = db.prepare(sql);
		return stmt.run(...bind(params));
	};
	const allSql = (sql: string, params: Params): Record<string, unknown>[] => {
		const stmt = db.prepare(sql);
		return stmt.all(...bind(params)) as unknown as Record<string, unknown>[];
	};
	const rawSql = (sql: string, params: Params): unknown[][] => {
		const stmt = db.prepare(sql);
		stmt.setReturnArrays(true);
		return stmt.all(...bind(params)) as unknown as unknown[][];
	};

	const bound = (sql: string, params: Params): BoundStub => ({
		all: async () => ({results: allSql(sql, params) as never[]}),
		run: async () => {
			runSql(sql, params);
			return {success: true, meta: {}};
		},
		raw: async () => rawSql(sql, params) as never[],
		first: async () => {
			const rows = allSql(sql, params);
			return (rows[0] as never) ?? null;
		},
	});

	const prepare = (sql: string): PreparedStub => ({
		bind: (...params: Params) => bound(sql, params),
		all: async () => ({results: allSql(sql, []) as never[]}),
		run: async () => {
			runSql(sql, []);
			return {success: true, meta: {}};
		},
		raw: async () => rawSql(sql, []) as never[],
		first: async () => {
			const rows = allSql(sql, []);
			return (rows[0] as never) ?? null;
		},
	});

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
