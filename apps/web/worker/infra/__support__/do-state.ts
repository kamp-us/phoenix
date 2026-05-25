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

	const exec = (query: string, ...bindings: ReadonlyArray<unknown>) =>
		Effect.sync(() => {
			const stmt = db.prepare(query);
			const isSelect = /^\s*(select|pragma)/i.test(query);
			const params = bindings.map((b) =>
				b === undefined ? null : typeof b === "boolean" ? (b ? 1 : 0) : b,
			) as unknown as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;
			let rows: Array<Record<string, unknown>>;
			if (isSelect) {
				rows = stmt.all(...params) as Array<Record<string, unknown>>;
			} else {
				stmt.run(...params);
				rows = [];
			}
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
			sql: {exec} as never,
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
