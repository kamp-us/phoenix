/**
 * A `node:sqlite`-backed stand-in for the Cloudflare `D1Database` binding, scoped
 * to the three tables this seed writes. A real SQL engine behind the D1 surface
 * `drizzle-orm/d1` calls, so the seed's production drizzle inserts run unmodified
 * against actual SQLite rows — the same idiom as
 * `apps/web/worker/db/sqlite-d1.testing.ts`, kept local so the package stays
 * self-contained (no `@kampus/web` import, no Vite `import.meta.glob`).
 *
 * NOT a production artifact — the `*.testing.ts` suffix keeps it out of any build
 * and it is imported only by the unit tests.
 */
import {DatabaseSync, type SQLInputValue} from "node:sqlite";
import {assertRestParam} from "./d1-rest.ts";

/**
 * DDL for the three seeded read-model tables, copied verbatim from the canonical
 * migration `apps/web/worker/db/drizzle/migrations/0000_d1_baseline.sql` (the
 * column set the local `schema.ts` mirrors). Only the tables the seed touches.
 */
const SEED_TABLES_DDL = `
CREATE TABLE term_summary (
	slug text PRIMARY KEY NOT NULL,
	title text NOT NULL,
	first_letter text NOT NULL,
	definition_count integer DEFAULT 0 NOT NULL,
	total_score integer DEFAULT 0 NOT NULL,
	excerpt text,
	top_definition_id text,
	first_at integer,
	last_activity_at integer,
	last_edit_at integer,
	last_event_id text DEFAULT '' NOT NULL
);
CREATE TABLE definition_view (
	id text PRIMARY KEY NOT NULL,
	author_id text NOT NULL,
	author_name text NOT NULL,
	term_slug text NOT NULL,
	term_title text NOT NULL,
	body text DEFAULT '' NOT NULL,
	body_excerpt text NOT NULL,
	score integer DEFAULT 0 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer NOT NULL,
	deleted_at integer,
	last_event_id text DEFAULT '' NOT NULL
);
CREATE TABLE post_summary (
	id text PRIMARY KEY NOT NULL,
	slug text,
	title text NOT NULL,
	url text,
	host text,
	body text DEFAULT '' NOT NULL,
	body_excerpt text,
	author_id text NOT NULL,
	author_name text NOT NULL,
	tags text DEFAULT '' NOT NULL,
	score integer DEFAULT 0 NOT NULL,
	comment_count integer DEFAULT 0 NOT NULL,
	hot_score integer DEFAULT 0 NOT NULL,
	created_at integer NOT NULL,
	updated_at integer NOT NULL,
	last_activity_at integer NOT NULL,
	deleted_at integer,
	last_event_id text DEFAULT '' NOT NULL
);
`;

type Params = ReadonlyArray<unknown>;

interface BoundStub {
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{
		success: true;
		meta: {changes: number; last_row_id: number};
		results: unknown[];
	}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

interface PreparedStub extends BoundStub {
	bind: (...params: Params) => BoundStub;
}

/**
 * Normalize a JS value to a `node:sqlite` bound param, **first** asserting it
 * against the same REST `params` contract the live D1 REST client enforces
 * ({@link assertRestParam}). Without this the `node:sqlite` engine binds a `null`
 * happily — strictly more permissive than real D1 — so a REST-incompatible param
 * shape (e.g. a nullable column bound instead of omitted) would pass the unit suite
 * yet die against the live seed (#569/#571). Validating here closes that fidelity
 * gap: the fake rejects exactly what real D1 rejects.
 */
function toSqliteParam(value: unknown, index: number): SQLInputValue {
	assertRestParam(value, index);
	if (typeof value === "boolean") return value ? 1 : 0;
	return value as SQLInputValue;
}

export interface SqliteD1 {
	readonly d1: D1Database;
	close: () => void;
}

/** Build an in-memory SQLite D1 with the three seeded tables created. */
export function makeSeedTestDb(): SqliteD1 {
	const db = new DatabaseSync(":memory:");
	// D1 ships `foreign_keys` OFF; node:sqlite defaults it ON. Keep the fake faithful.
	db.exec("PRAGMA foreign_keys=OFF;");
	db.exec(SEED_TABLES_DDL);

	const bind = (params: Params): SQLInputValue[] => params.map((p, i) => toSqliteParam(p, i));

	const metaFrom = (result: {changes: number | bigint; lastInsertRowid: number | bigint}) => ({
		changes: Number(result.changes),
		last_row_id: Number(result.lastInsertRowid),
	});

	const runSql = (sql: string, params: Params) => {
		const stmt = db.prepare(sql);
		return metaFrom(stmt.run(...bind(params)));
	};
	const allSql = (sql: string, params: Params): Record<string, unknown>[] => {
		const stmt = db.prepare(sql);
		return stmt.all(...bind(params)) as Record<string, unknown>[];
	};

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

	// biome-ignore lint/plugin: only the prepare/exec/batch slice drizzle-orm/d1 calls is implemented; the full `D1Database` surface can't be built honestly in a fake, so this assembly point widens to it once (same idiom as apps/web/worker/db/sqlite-d1.testing.ts).
	const d1 = {
		prepare,
		exec: async (sql: string) => {
			db.exec(sql);
			return {count: 0, duration: 0};
		},
		batch: async (statements: BoundStub[]) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const out = [];
				for (const stmt of statements) out.push(await stmt.run());
				db.exec("COMMIT");
				return out;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;

	return {d1, close: () => db.close()};
}
