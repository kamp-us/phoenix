/**
 * A `node:sqlite`-backed stand-in for the Cloudflare `D1Database` binding: a
 * *real* SQL engine behind the same D1 surface `drizzle-orm/d1` calls, so the
 * production `drizzle(d1, {schema})` instance and every service method run
 * unmodified against actual SQLite rows.
 *
 * Only the slice of the D1 contract `drizzle-orm/d1` exercises is implemented
 * (see `node_modules/drizzle-orm/d1/session.js`): `prepare`/`bind`/`all`/`run`/
 * `raw`/`first`, `batch`, `exec`. `batch` runs the tuple inside a SQLite
 * transaction and rolls the whole thing back on a mid-batch failure (D1's
 * atomic-batch contract, which the vote write paths depend on).
 *
 * NOT a production artifact — the `*.testing.ts` suffix keeps it out of the unit
 * glob and it is never imported by the worker graph.
 */
import {DatabaseSync, type SQLInputValue} from "node:sqlite";

// Every committed migration, eagerly inlined as raw SQL and applied in filename
// order — so a test DB reflects the full schema, not just the baseline. A new
// `NNNN_*.sql` is picked up with no edit here.
const migrationSql: Record<string, string> = import.meta.glob("./drizzle/migrations/*.sql", {
	query: "?raw",
	import: "default",
	eager: true,
});
const orderedMigrations = Object.entries(migrationSql)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([, sql]) => sql);

type Params = ReadonlyArray<unknown>;

/**
 * The subset of D1's `meta` envelope the fake can report truthfully from
 * `node:sqlite`: `changes` (rows affected) and `last_row_id` (last INSERT
 * rowid). D1's real `D1Meta` also carries timing/size fields.
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

// Callable with no params because drizzle's batch path takes all()/run()/raw()
// without a bind for param-less statements.
interface PreparedStub extends BoundStub {
	bind: (...params: Params) => BoundStub;
}

/** Normalize JS values to ones `node:sqlite` accepts as bound params. */
function toSqliteParam(value: unknown): SQLInputValue {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	// drizzle only ever binds primitives the write paths produce
	// (string/number/null/bigint/bytes), which are exactly `SQLInputValue`.
	return value as SQLInputValue;
}

export interface SqliteD1 {
	/** The `D1Database`-shaped binding to hand `drizzle(d1, {schema})`. */
	readonly d1: D1Database;
	/** Apply a migration's SQL (`--> statement-breakpoint`-split). */
	applyMigration: (sql: string) => void;
	/** Tear down the in-memory database. */
	close: () => void;
}

/** Build an in-memory SQLite database fronted by a D1-shaped binding. */
export function makeSqliteD1(): SqliteD1 {
	const db = new DatabaseSync(":memory:");

	const bind = (params: Params): SQLInputValue[] => params.map(toSqliteParam);

	// `lastInsertRowid` is `number | bigint`, but D1's `meta` types both fields as
	// `number`. Real rowids here are small, so `Number(bigint)` is lossless.
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

	// A `SELECT` run through `.run()` surfaces rows in `results` (some stats
	// recomputes read `r.results[0]` off `db.run(sql\`SELECT ...\`)`); DML returns
	// empty `results` and the write's `meta` envelope.
	const runEnvelope = (
		sql: string,
		params: Params,
	): {results: Record<string, unknown>[]; meta: D1MetaEnvelope} => {
		// CAVEAT: leading-keyword sniff only — a `WITH ... SELECT` CTE and a
		// `... RETURNING` write both misclassify, but neither shape appears in the
		// narrow slice drizzle-orm/d1 drives here, so it's sufficient for the fake.
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
			// Faithful atomic batch: a SQLite transaction, rolled back on the first
			// failure so a mid-batch error leaves no partial write. Each entry is the
			// full `run()` envelope, so per-statement `meta` (`changes`/`last_row_id`)
			// stays observable in-process — the micro-tier the fate wire can't serialize.
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
					// Swallow ONLY genuinely-idempotent re-applies. A `no such
					// table`/`no such index` is a real defect that would silently drop
					// a constraint the atomicity tests depend on — let those throw.
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
 * The one-call test-kit factory: a fresh, independent in-memory SQLite D1 with
 * the baseline migration applied (so tests never cross-contaminate).
 *
 * `foreign_keys=OFF` is load-bearing: `node:sqlite` defaults the pragma ON,
 * Cloudflare D1 ships it OFF. Forcing it OFF keeps the fake faithful so a test
 * never passes or fails on an FK constraint D1 wouldn't enforce.
 */
export function makeSqliteTestDb(): SqliteD1 {
	const sqlite = makeSqliteD1();
	sqlite.applyMigration("PRAGMA foreign_keys=OFF;");
	for (const sql of orderedMigrations) sqlite.applyMigration(sql);
	return sqlite;
}
