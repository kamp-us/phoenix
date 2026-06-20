/**
 * A `node:sqlite`-backed `D1Database` stand-in scoped to the one table the grant
 * CLI writes (`user`). A real SQL engine behind the `drizzle-orm/d1` surface, so
 * `setRole`/`listModerators` run their production drizzle statements unmodified
 * against actual rows — the same idiom as `@kampus/preview-seed`'s
 * `sqlite-d1.testing.ts`, kept local so the package stays self-contained.
 *
 * NOT a production artifact — the `*.testing.ts` suffix keeps it out of any build;
 * imported only by the unit tests.
 */
// biome-ignore lint/plugin: ADR-0082 carve-out, same as @kampus/preview-seed's fake — the grant's writes are a single plain UPDATE (no FTS5/collation, none of the engine divergence the node:sqlite ban guards against), and `d1-rest.ts` already drives real D1 for the live path; the fake only backs the fast unit suite. See ADR 0082 + #633.
import {DatabaseSync, type SQLInputValue} from "node:sqlite";

// The `user` columns the grant statements touch, copied from
// `apps/web/worker/db/drizzle/migrations/0000_d1_baseline.sql` + the 0007 `role` add.
const USER_DDL = `
CREATE TABLE user (
	id text PRIMARY KEY NOT NULL,
	name text,
	email text NOT NULL,
	image text,
	type text DEFAULT 'human' NOT NULL,
	role text DEFAULT 'member' NOT NULL,
	email_verified integer,
	username text UNIQUE,
	created_at integer,
	updated_at integer
);
`;

type Params = ReadonlyArray<unknown>;

interface BoundStub {
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{success: true; meta: Record<string, unknown>; results: unknown[]}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

interface PreparedStub extends BoundStub {
	bind: (...params: Params) => BoundStub;
}

const toSqliteParam = (value: unknown): SQLInputValue => {
	if (typeof value === "boolean") return value ? 1 : 0;
	return value as SQLInputValue;
};

export interface SqliteD1 {
	readonly d1: D1Database;
	close: () => void;
}

export function makeGrantTestDb(): SqliteD1 {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=OFF;");
	db.exec(USER_DDL);

	const bind = (params: Params): SQLInputValue[] => params.map((p) => toSqliteParam(p));

	const metaFrom = (result: {changes: number | bigint; lastInsertRowid: number | bigint}) => ({
		changes: Number(result.changes),
		last_row_id: Number(result.lastInsertRowid),
	});

	const runSql = (sql: string, params: Params) => metaFrom(db.prepare(sql).run(...bind(params)));
	const allSql = (sql: string, params: Params): Record<string, unknown>[] =>
		db.prepare(sql).all(...bind(params)) as Record<string, unknown>[];

	const runEnvelope = (sql: string, params: Params) =>
		/^\s*select/i.test(sql)
			? {results: allSql(sql, params), meta: {changes: 0, last_row_id: 0}}
			: {results: [] as unknown[], meta: runSql(sql, params)};

	const bound = (sql: string, params: Params): BoundStub => ({
		all: async () => ({results: allSql(sql, params) as never[]}),
		run: async () => {
			const {results, meta} = runEnvelope(sql, params);
			return {success: true, meta, results};
		},
		raw: async () => {
			const stmt = db.prepare(sql);
			stmt.setReturnArrays(true);
			return stmt.all(...bind(params)) as never[];
		},
		first: async () => (allSql(sql, params)[0] as never) ?? null,
	});

	const prepare = (sql: string): PreparedStub => ({
		...bound(sql, []),
		bind: (...params: Params) => bound(sql, params),
	});

	// biome-ignore lint/plugin: only the prepare/exec slice drizzle-orm/d1 calls is implemented; the full `D1Database` surface can't be built honestly in a fake, so this assembly point widens to it once (same idiom as @kampus/preview-seed).
	const d1 = {
		prepare,
		exec: async (sql: string) => {
			db.exec(sql);
			return {count: 0, duration: 0};
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;

	return {d1, close: () => db.close()};
}
