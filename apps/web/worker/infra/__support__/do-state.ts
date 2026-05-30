/**
 * A node-pool fake of alchemy's `Cloudflare.DurableObjectState["Service"]` value.
 *
 * Task 5 ports `ConnectionDO`/`TopicDO` onto the Effect DO model, but the workerd
 * black-box harness (real DO instances, alarms) is task 7. So this gives the
 * node-pool unit test a real-enough `DurableObjectState`: a `Map`-backed KV
 * (`storage.get/put`), a `node:sqlite`-backed `storage.sql.exec` (a real SQL
 * engine, returning a `SqlCursor` with `.toArray()`/`.one()`), and a single-slot
 * alarm (`getAlarm`/`setAlarm`/`deleteAlarm`) the test fires manually. Only the
 * slice the live-fan-out instances touch is implemented.
 *
 * The `storage.sql.raw` shim mirrors the underlying `cf.SqlStorage` interface
 * (sync `exec` returning a cursor with `columnNames` + a sync `raw()` iterable)
 * so the upstream `@effect/sql-sqlite-do` SqliteClient/Migrator drive the same
 * fake schema as the rest of the test (used by the topic-instance harness to
 * apply migrations before `makeTopicInstance`).
 *
 * NOT a production artifact — it lives under `__support__/` and is never imported
 * by the worker graph.
 */
import {DatabaseSync} from "node:sqlite";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

export interface FakeDurableObjectState {
	/** The `DurableObjectState`-shaped service value to hand the instance builder. */
	readonly state: DurableObjectStateValue;
	/** Fire the scheduled alarm (no-op if none is set), as workerd would at the time. */
	readonly hasAlarm: () => boolean;
	/** Tear down the in-memory database. */
	readonly close: () => void;
}

/**
 * Build a fake DO state with its own in-memory SQLite + KV. Each call is one DO
 * instance; pass `db`/`kv` to share storage across instances (simulating the same
 * named DO surviving an eviction — a fresh in-memory cache over persisted state).
 */
export function makeFakeDurableObjectState(options?: {
	readonly id?: string;
	readonly db?: DatabaseSync;
	readonly kv?: Map<string, unknown>;
}): FakeDurableObjectState {
	const db = options?.db ?? new DatabaseSync(":memory:");
	const kv = options?.kv ?? new Map<string, unknown>();
	let alarm: number | null = null;

	/** Run a query against the node:sqlite engine and materialize rows once. */
	const runQuery = (query: string, bindings: ReadonlyArray<unknown>) => {
		const stmt = db.prepare(query);
		const isSelect = /^\s*(select|pragma)/i.test(query);
		const params = bindings.map((b) =>
			b === undefined ? null : typeof b === "boolean" ? (b ? 1 : 0) : b,
		) as unknown as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;
		if (isSelect) {
			return stmt.all(...params) as Array<Record<string, unknown>>;
		}
		stmt.run(...params);
		return [] as Array<Record<string, unknown>>;
	};

	const exec = (query: string, ...bindings: ReadonlyArray<unknown>) =>
		Effect.sync(() => {
			const rows = runQuery(query, bindings);
			// A `SqlCursor` is a `Stream` of rows with `.toArray()`/`.one()`/`.next()`.
			let index = 0;
			const cursor = Object.assign(Stream.fromIterable(rows), {
				toArray: () => Effect.succeed([...rows]),
				one: () => Effect.succeed(rows[0]),
				next: () =>
					Effect.succeed(
						index < rows.length
							? {done: false as const, value: rows[index++]}
							: {done: true as const},
					),
				raw: () => Stream.fromIterable(rows.map((r) => Object.values(r))),
				columnNames: rows[0] ? Object.keys(rows[0]) : [],
				rowsRead: Effect.succeed(rows.length),
				rowsWritten: Effect.succeed(0),
			});
			return cursor as never;
		});

	/**
	 * Sync `cf.SqlStorage`-shaped shim — the upstream `@effect/sql-sqlite-do`
	 * `SqliteClient` calls `db.exec(sql, ...params)` synchronously and iterates
	 * the cursor's `raw()` as a sync iterable. The fake routes both through
	 * the same `node:sqlite` connection as the Effect-wrapped `exec`, so a
	 * migrator running through this shim and an instance reading through the
	 * Effect surface see the same schema and rows.
	 */
	const rawExec = (query: string, ...bindings: Array<unknown>) => {
		const rows = runQuery(query, bindings);
		const columnNames = rows[0] ? Object.keys(rows[0]) : [];
		return {
			columnNames,
			raw: () => rows.map((r) => columnNames.map((c) => r[c]))[Symbol.iterator](),
			toArray: () => [...rows],
			one: () => rows[0],
			next: () => ({done: rows.length === 0, value: rows[0]}),
			get rowsRead() {
				return rows.length;
			},
			get rowsWritten() {
				return 0;
			},
			[Symbol.iterator]: () => rows[Symbol.iterator](),
		};
	};
	const rawSql = {
		exec: rawExec,
		get databaseSize() {
			return 0;
		},
	};

	const state = {
		id: {toString: () => options?.id ?? "fake-do", name: options?.id} as never,
		storage: {
			get: (<T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined)) as never,
			put: (<T>(key: string, value: T) =>
				Effect.sync(() => {
					kv.set(key, value);
				})) as never,
			delete: ((key: string) => Effect.sync(() => kv.delete(key))) as never,
			getAlarm: () => Effect.sync(() => alarm),
			setAlarm: ((scheduledTime: number) =>
				Effect.sync(() => {
					alarm = scheduledTime;
				})) as never,
			deleteAlarm: () =>
				Effect.sync(() => {
					alarm = null;
				}),
			sql: {exec, raw: rawSql} as never,
		} as never,
	} as unknown as DurableObjectStateValue;

	return {
		state,
		hasAlarm: () => alarm !== null,
		close: () => {
			if (!options?.db) {
				db.close();
			}
		},
	};
}
