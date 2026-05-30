/**
 * `TopicDO` — the topic-role half of phoenix's live fan-out (ADR 0023, split per
 * ADR 0025), on alchemy's modular Effect Durable Object model (ADR 0028).
 *
 * One instance per topic, named `topic:<topicKey>`. It owns the **durable
 * subscriber registry** for that topic (in `state.storage.sql`), the **publish
 * fan-out**, and the **alarm reap** — nothing about any client's SSE stream.
 * The algorithm (epoch-based stale detection, the consecutive-miss reap, the
 * bounded fan-out) is a verbatim port of the legacy `cloudflare:workers` class.
 *
 * **Modular `.make()` form** — the `TopicDO` class is a lightweight Tag (identity
 * + the `TopicRpc` contract on its 2nd type param, NO inline body), and
 * {@link TopicDOLive} is the implementation Layer. Splitting the two breaks the
 * `ConnectionDO` ↔ `TopicDO` circular reference that forced the old `as never`
 * sibling-cast seam: the sibling `ConnectionDO` namespace is obtained by
 * `yield*`-ing its Tag (a context lookup alchemy excludes from the Layer's
 * requirements via `DurableObjectServices`), so there is no circular Layer
 * dependency and no cast. Siblings are addressed by name
 * (`getByName(\`connection:${id}\`)`) — never `idFromName`/`idFromString`/`get`
 * (unavailable on the alchemy stub).
 *
 * The `ConnectionDO` sibling is resolved **per fan-out call** (`yield*
 * ConnectionDO` inside `publish`/`alarm`, never in init): resolving it in shared
 * init would pin the sibling Tag onto this Layer's requirements and form a
 * circular Layer dependency with `ConnectionDOLive`. Per-call, the Tag
 * requirement lands on the RPC method's `R` instead (declared in
 * {@link TopicRpcSurface}).
 *
 * The behavior itself lives in {@link makeTopicInstance} below. The builder takes
 * the resolved `Cloudflare.DurableObjectState` plus a resolver for the sibling
 * connection stub, so the same algorithm is unit-testable in the node pool
 * (`do.test.ts`) without workerd.
 */
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ConnectionDO from "./connection-do.ts";
import type {
	ConnectionRpc,
	DeliverFrame,
	DeliverResult,
	PublishMessage,
	TopicRpc,
} from "./protocol.ts";

/**
 * Per-cross-DO-RPC budget for the publish/alarm fan-out. A `deliver`/`probe`
 * call to an unreachable connection DO must abort here rather than hang on the
 * runtime's multi-minute subrequest timeout — a stalled best-effort live deliver
 * would block every later publish behind it (a DO is single-threaded). A
 * timed-out RPC is treated as "couldn't reach" (the row is left, not pruned).
 */
const FANOUT_TIMEOUT_MS = 2_000;

/**
 * Consecutive unreachable `alarm()` probes before a subscriber row is reaped. The
 * alarm fires every 60s, so a connection must stay unreachable across the whole
 * cycle before its dead row is evicted; a single transient failure only accrues
 * one miss (well under the threshold) and never deletes a live subscription.
 */
const MAX_PROBE_MISSES = 3;

/** The state value alchemy hands the per-instance Effect (`yield* DurableObjectState`). */
type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

/**
 * A subscriber row: which connection (by its human-readable `connectionId`, the
 * key the topic DO re-derives `connection:${connectionId}` from) wants events for
 * this topic. `epoch` captures the connection's stream lifetime at register
 * time; on deliver/probe a *reachable* connection reports its current epoch
 * and a row that mismatches is pruned. `misses` counts consecutive unreachable
 * `alarm()` probes so a connection that stays dead is eventually reaped.
 */
interface SubscriberRow {
	connectionId: string;
	subId: string;
	epoch: number;
	updatedAt: number;
	misses: number;
	// `sql.exec<T>` requires `T extends Record<string, SqlStorageValue>`; the
	// index signature satisfies that constraint over the named columns above.
	[column: string]: string | number;
}

/**
 * The topic DO's public method surface (typed RPC + the reap `alarm`). `SR` is
 * the sibling resolver's requirement (`ConnectionDO | Worker` in the real DO —
 * the connection sibling is resolved per call, `Effect.map(ConnectionDO, …)` —
 * and `never` in the test); it surfaces on `publish`/`alarm`, which resolve the
 * connection sibling.
 */
export interface TopicInstance<SR = never> {
	readonly register: TopicRpc["register"];
	readonly deregister: TopicRpc["deregister"];
	readonly publish: (
		message: PublishMessage,
	) => Effect.Effect<{readonly delivered: number}, never, SR>;
	readonly alarm: () => Effect.Effect<void, never, SR>;
}

/**
 * Build the topic-role DO's per-instance methods.
 *
 * `state` is the resolved `Cloudflare.DurableObjectState` for this instance.
 * `resolveConnection` is the sibling resolver — the modular DO passes a thunk
 * that resolves the connection namespace per call (`Effect.map(ConnectionDO, …)`)
 * and addresses a connection by id, so the cross-DO Tag lands on the RPC method's
 * `R` rather than the Layer's init requirements (non-circular under `.make()`).
 * The subscriber registry lives in `state.storage.sql`, addressed back to a
 * connection by `getByName(\`connection:${row.connectionId}\`)`.
 *
 * The `subscribers` schema is owned by the Effect SQL migrator wired in
 * {@link TopicDOLive} (`./migrations/topic/*.ts`) — the builder assumes the table
 * already exists and never issues DDL.
 */
export const makeTopicInstance = <SR = never>(
	state: DurableObjectStateValue,
	resolveConnection: (connectionId: string) => Effect.Effect<ConnectionRpc, never, SR>,
): TopicInstance<SR> => {
	// DML execs return an `Effect<SqlCursor>`; for writes the cursor is unused, so
	// discard it with `asVoid` (yielding the cursor otherwise floats — `SqlCursor`
	// is itself a `Stream`).
	const exec = (query: string, ...bindings: ReadonlyArray<string | number>) =>
		Effect.asVoid(state.storage.sql.exec(query, ...bindings));

	const loadSubscriberRows = Effect.flatMap(
		state.storage.sql.exec<SubscriberRow>(
			`SELECT connectionId, subId, epoch, updatedAt, misses FROM subscribers`,
		),
		(cursor) => cursor.toArray(),
	);

	const deleteRow = (connectionId: string, subId: string) =>
		exec(`DELETE FROM subscribers WHERE connectionId = ? AND subId = ?`, connectionId, subId);

	const ensureAlarm = Effect.gen(function* () {
		const existing = yield* state.storage.getAlarm();
		if (existing == null) {
			yield* state.storage.setAlarm(Date.now() + 60_000);
		}
	});

	const register: TopicInstance["register"] = (row) =>
		Effect.gen(function* () {
			// A fresh register means the connection is alive, so `misses` starts (and
			// on re-register resets) at 0 — a re-subscribe clears any accrued misses.
			yield* exec(
				`INSERT INTO subscribers (connectionId, subId, epoch, updatedAt, misses)
					VALUES (?, ?, ?, ?, 0)
					ON CONFLICT(connectionId, subId) DO UPDATE SET
						epoch = excluded.epoch,
						updatedAt = excluded.updatedAt,
						misses = 0`,
				row.connectionId,
				row.subId,
				row.epoch,
				Date.now(),
			);
			// Keep one alarm running to prune rows whose connection DO has gone away
			// without deregistering (eviction, crash).
			yield* ensureAlarm;
			return {ok: true} as const;
		});

	const deregister: TopicInstance["deregister"] = (input) =>
		Effect.gen(function* () {
			yield* deleteRow(input.connectionId, input.subId);
			return {ok: true} as const;
		});

	const publish: TopicInstance<SR>["publish"] = (message) =>
		Effect.gen(function* () {
			const rows = yield* loadSubscriberRows;
			const outcomes = yield* Effect.forEach(
				rows,
				(row) =>
					Effect.gen(function* () {
						const frame: DeliverFrame = {
							kind: message.kind === "entity" ? "next" : "connection",
							id: row.subId,
							event: message.frame,
							...(message.eventId !== undefined ? {eventId: message.eventId} : {}),
						};
						// `undefined` reported = couldn't reach/parse (leave the row);
						// a number = the connection's reported current epoch.
						const result = yield* resolveConnection(row.connectionId).pipe(
							Effect.flatMap((connection) => connection.deliver({frame, epoch: row.epoch})),
							// Bound the fan-out: an unreachable connection aborts here instead
							// of stalling the (single-threaded) topic DO. ANY failure — a
							// timeout, a failed RPC, or a DO-side defect — is "couldn't reach",
							// not "confirmed stale" (mirrors the legacy try/catch). `catchCause`
							// swallows defects too, so one misbehaving sibling can't crash the
							// whole fan-out.
							Effect.timeout(FANOUT_TIMEOUT_MS),
							// The typed `undefined` IS the value — downstream narrows on
							// `result !== undefined` to mean "couldn't reach". `Effect.void`
							// would type it `void`, breaking that union; not equivalent here.
							// @effect-diagnostics-next-line effect/effectSucceedWithVoid:off
							Effect.catchCause(() => Effect.succeed<DeliverResult | undefined>(undefined)),
						);
						// A *reachable* connection reporting a different current epoch
						// means the stream this row was registered for is gone — prune it.
						const prune = result !== undefined && !result.delivered && result.epoch !== row.epoch;
						return {row, delivered: result?.delivered === true, prune};
					}),
				{concurrency: "unbounded"},
			);
			let delivered = 0;
			for (const outcome of outcomes) {
				if (outcome.delivered) {
					delivered += 1;
				} else if (outcome.prune) {
					yield* deleteRow(outcome.row.connectionId, outcome.row.subId);
				}
			}
			return {delivered};
		});

	const alarm: TopicInstance<SR>["alarm"] = () =>
		Effect.gen(function* () {
			const rows = yield* loadSubscriberRows;
			yield* Effect.forEach(
				rows,
				(row) =>
					Effect.gen(function* () {
						// `/probe` reports the connection's current epoch without
						// enqueueing onto its stream. Bounded so a dead connection aborts
						// fast instead of stalling the prune.
						const reported = yield* resolveConnection(row.connectionId).pipe(
							Effect.flatMap((connection) => connection.probe()),
							Effect.timeout(FANOUT_TIMEOUT_MS),
							Effect.map((r): number | undefined => r.epoch),
							// ANY failure/defect/timeout → "couldn't reach" (mirrors legacy).
							// Typed `undefined` is the value the `reported === undefined` check
							// below reads; `Effect.void` would type it `void` — not equivalent.
							// @effect-diagnostics-next-line effect/effectSucceedWithVoid:off
							Effect.catchCause(() => Effect.succeed<number | undefined>(undefined)),
						);
						if (reported === undefined) {
							// Unreachable: accrue a miss; reap only after enough consecutive ones.
							const misses = row.misses + 1;
							if (misses >= MAX_PROBE_MISSES) {
								yield* deleteRow(row.connectionId, row.subId);
							} else {
								yield* exec(
									`UPDATE subscribers SET misses = ? WHERE connectionId = ? AND subId = ?`,
									misses,
									row.connectionId,
									row.subId,
								);
							}
						} else if (reported !== row.epoch) {
							yield* deleteRow(row.connectionId, row.subId);
						} else if (row.misses !== 0) {
							// Reachable and current: clear any accrued misses so a transient
							// blip never accumulates toward eviction across reachable intervals.
							yield* exec(
								`UPDATE subscribers SET misses = 0 WHERE connectionId = ? AND subId = ?`,
								row.connectionId,
								row.subId,
							);
						}
					}),
				{concurrency: "unbounded"},
			);
			const remaining = yield* Effect.flatMap(
				state.storage.sql.exec<{n: number}>(`SELECT COUNT(*) AS n FROM subscribers`),
				(cursor) => cursor.one(),
			);
			if (remaining.n > 0) {
				yield* state.storage.setAlarm(Date.now() + 60_000);
			}
		});

	return {register, deregister, publish, alarm};
};

/**
 * The typed surface callers reach across the `TopicDO` stub: a sibling
 * `ConnectionDO` calls `register`/`deregister`, and the worker's `LiveTopics`
 * handle calls `publish`. `alarm` is invoked by the runtime, not via a stub, but
 * is part of the DO shape so it stays declared. `register`/`deregister` resolve
 * nothing → `R = never`; `publish`/`alarm` resolve the connection sibling per
 * call → `R = ConnectionDO | Worker` (`yield* ConnectionDO` also needs the
 * `Worker` binding service; alchemy provides both on the DO side, and the worker
 * — which yields `ConnectionDO`/`Worker` in init and hosts the DO — satisfies
 * them for its `LiveTopics.publish` call), so no cast is needed at either seam.
 */
export type TopicRpcSurface = Pick<
	TopicInstance<ConnectionDO | Cloudflare.Worker>,
	"register" | "deregister" | "publish" | "alarm"
>;

/**
 * `TopicDO` Tag — identity plus the {@link TopicRpcSurface} contract callers
 * reach across the stub. No inline body: the runtime implementation is
 * {@link TopicDOLive}, so importing this Tag pulls in no DO runtime code (the
 * bundler tree-shakes `.make()` out of consumers).
 */
export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO, TopicRpcSurface>()(
	"TopicDO",
) {}

/**
 * The `TopicDO` implementation Layer. The `ConnectionDO` sibling namespace is
 * resolved per fan-out call (`Effect.map(ConnectionDO, …)` inside the resolver
 * thunk — never in shared init, which would pin the sibling Tag onto this
 * Layer's requirements and form a circular Layer dependency with
 * `ConnectionDOLive`), then each call addresses a specific connection by name.
 */
export const TopicDOLive = TopicDO.make(
	Effect.gen(function* () {
		// ── SHARED INIT (once per namespace) ──
		// Do NOT resolve the ConnectionDO sibling here: `yield* ConnectionDO` in init
		// pins the sibling Tag onto this Layer's requirements, and paired with
		// `yield* TopicDO` in ConnectionDOLive's init that is a circular Layer
		// dependency `Layer.mergeAll` can't satisfy. Resolve it per fan-out call
		// (inside `publish`/`alarm`) instead — the Tag requirement then lands on the
		// RPC method's `R`, which alchemy provides from the DO's own services.
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init and
		// break the two-phase DO model — so the nested Effect is intentional here.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			// ── PER-INSTANCE (once per instance wake) ──
			const state = yield* Cloudflare.DurableObjectState;
			// Run pending SQL migrations BEFORE building the instance — the migrator
			// layer runs on construction (`Layer.effectDiscard`) so by the time the
			// inner builder runs, `effect_sql_migrations` is up-to-date and the
			// `subscribers` schema matches what the builder expects. Migrations are
			// idempotent: on a fresh DO both run; on an existing DO the recorded
			// id in `effect_sql_migrations` gates pending ones. `import.meta.glob`
			// resolves at Vite build time, so the migration modules ship with the
			// worker bundle. `state.storage.sql.raw` is the underlying `cf.SqlStorage`
			// handle — alchemy wraps `exec` to return an Effect; the upstream adapter
			// expects the raw sync handle.
			const sqliteLayer = SqliteClient.layer({db: state.storage.sql.raw});
			const migratorLayer = SqliteMigrator.layer({
				loader: SqliteMigrator.fromGlob(
					import.meta.glob("./migrations/topic/*.ts", {eager: false}),
				),
			}).pipe(Layer.provide(sqliteLayer));
			// `Effect.orDie` absorbs MigrationError | SqlError into a defect — a
			// migration failure here is a hard infra crash (the DO is unusable), not
			// a recoverable error to surface to callers. Merging the two layers into
			// one `provide` keeps the service lifecycle coherent.
			return yield* Effect.sync(() =>
				makeTopicInstance(
					state,
					(connectionId): Effect.Effect<ConnectionRpc, never, ConnectionDO | Cloudflare.Worker> =>
						// Resolve the sibling ConnectionDO Tag per call (alchemy provides it —
						// plus the `Worker` binding service `yield* ConnectionDO` needs — on the
						// DO side), then address one connection by its human-readable name. The
						// typed stub's RPC surface matches `ConnectionRpc` exactly — no cast.
						Effect.map(ConnectionDO, (connections) =>
							connections.getByName(`connection:${connectionId}`),
						),
				),
			).pipe(Effect.provide(migratorLayer), Effect.orDie);
		});
	}),
);
