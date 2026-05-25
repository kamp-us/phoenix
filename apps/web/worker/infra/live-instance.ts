/**
 * The per-instance logic for phoenix's live fan-out Durable Objects, on the
 * alchemy Effect DO model (ADR 0028, `.patterns/alchemy-durable-objects.md`).
 *
 * Both DOs are declared inline in `connection-do.ts` / `topic-do.ts` — those
 * files own the `DurableObjectNamespace<Self>()("Name", body)` shape and the
 * **lazy** sibling resolution (`yield* TopicDO` / `yield* ConnectionDO` inside
 * an RPC method, never in init — an eager circular `yield*` OOMs the build).
 * The behavior itself lives here, in two instance-factory builders that take the
 * already-resolved `Cloudflare.DurableObjectState` value plus a *lazy* resolver
 * for the sibling stub. This keeps the connection↔topic algorithm — held SSE
 * stream, generation-based stale detection, the durable subscriber registry in
 * `state.storage.sql`, and the alarm reap — in one place that a node-pool unit
 * test (`live-instance.test.ts`) can drive without workerd. The observable SSE
 * contract is also covered black-box over HTTP in `tests/integration/fate-live.test.ts`.
 *
 * The wire frame shapes and topic helpers are shared via `../fate/live-protocol.ts`,
 * so the bus, the DOs, and the route all speak one vocabulary. The algorithm is a
 * verbatim port of phoenix's original `cloudflare:workers` live DOs onto the
 * alchemy Effect DO model + typed RPC — the algorithm itself is unchanged.
 */
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {DeliverFrame, PublishMessage, SubscribeControl} from "../fate/live-protocol.ts";
import {encodeFrame, SSE_HEADERS, topicsForSubscribe} from "../fate/live-protocol.ts";

/** Storage key for the persisted generation counter (survives eviction). */
const GENERATION_KEY = "generation";

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

/** What a topic DO reports back to the connection it delivered/probed. */
export interface DeliverResult {
	readonly delivered: boolean;
	readonly generation: number;
}

/** What a connection DO reports for a generation probe. */
export interface ProbeResult {
	readonly generation: number;
}

/** The typed RPC surface a {@link TopicDO} calls on a connection stub. */
export interface ConnectionRpc {
	readonly deliver: (input: {
		readonly frame: DeliverFrame;
		readonly generation: number;
	}) => Effect.Effect<DeliverResult, never, never>;
	readonly probe: () => Effect.Effect<ProbeResult, never, never>;
}

/** The typed RPC surface a {@link ConnectionDO} calls on a topic stub. */
export interface TopicRpc {
	readonly register: (row: {
		readonly connectionId: string;
		readonly subId: string;
		readonly generation: number;
	}) => Effect.Effect<{readonly ok: true}, never, never>;
	readonly deregister: (input: {
		readonly connectionId: string;
		readonly subId: string;
	}) => Effect.Effect<{readonly ok: true}, never, never>;
}

/**
 * A subscriber row: which connection (by its human-readable `connectionId`, the
 * key the topic DO re-derives `connection:${connectionId}` from) wants events for
 * this topic. `generation` captures the connection's stream lifetime at register
 * time; on deliver/probe a *reachable* connection reports its current generation
 * and a row that mismatches is pruned. `misses` counts consecutive unreachable
 * `alarm()` probes so a connection that stays dead is eventually reaped.
 */
interface SubscriberRow {
	connectionId: string;
	subId: string;
	generation: number;
	updatedAt: number;
	misses: number;
	// `sql.exec<T>` requires `T extends Record<string, SqlStorageValue>`; the
	// index signature satisfies that constraint over the named columns above.
	[column: string]: string | number;
}

/**
 * The connection DO's public method surface (typed RPC + the SSE `openStream`).
 * `SR` is the requirement the **lazy** sibling resolver introduces — in the real
 * DO it is the alchemy `Worker` service (`yield* TopicDO` needs it); in the
 * node-pool test it is `never` (the test injects in-process stubs). It surfaces
 * only on `subscribe`/`unsubscribe`, the methods that resolve the topic sibling.
 */
export interface ConnectionInstance<SR = never> {
	/**
	 * Open the SSE stream. The inline DO's `fetch` Effect reads `ownerId` /
	 * `connectionId` off `Cloudflare.Request` and calls this — keeping the impl
	 * free of the request service so the node-pool test drives it with plain args.
	 */
	readonly openStream: (input: {
		readonly ownerId: string | undefined;
		readonly connectionId: string | undefined;
	}) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>;
	readonly subscribe: (input: {
		readonly control: SubscribeControl;
		readonly ownerId: string | undefined;
	}) => Effect.Effect<{readonly ok: boolean}, never, SR>;
	readonly unsubscribe: (input: {
		readonly subId: string;
	}) => Effect.Effect<{readonly ok: true}, never, SR>;
	readonly deliver: ConnectionRpc["deliver"];
	readonly probe: ConnectionRpc["probe"];
}

/**
 * The topic DO's public method surface (typed RPC + the reap `alarm`). `SR` is
 * the lazy sibling resolver's requirement (alchemy `Worker` in the real DO,
 * `never` in the test); it surfaces on `publish`/`alarm`, which resolve the
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

// ---------------------------------------------------------------------------
// ConnectionDO instance
// ---------------------------------------------------------------------------

/**
 * Build the connection-role DO's per-instance methods.
 *
 * `state` is the resolved `Cloudflare.DurableObjectState` for this instance.
 * `resolveTopic` is the **lazy** sibling resolver — the inline DO passes a thunk
 * that does `yield* TopicDO` *inside* the call (never in init), so the cross-DO
 * binding stays circular-but-lazy (ADR 0028). The connection's own name is
 * `connection:${connectionId}`; the topic DO addresses it back by that key, so
 * `subscribe` registers under the client-supplied `connectionId`.
 */
export const makeConnectionInstance = <SR = never>(
	state: DurableObjectStateValue,
	resolveTopic: (topicKey: string) => Effect.Effect<TopicRpc, never, SR>,
): ConnectionInstance<SR> => {
	const encoder = new TextEncoder();

	// Per-instance, closure-held (was: instance fields on the legacy class). The
	// open SSE stream pins this DO in memory (no hibernation), so the controller +
	// subscription list live in memory; only `generation` is persisted.
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let ownerId: string | undefined;
	let connectionId: string | undefined;
	let generation: number | undefined;
	const subscriptions = new Map<string, {topics: ReadonlyArray<string>}>();

	const loadGeneration = Effect.gen(function* () {
		if (generation === undefined) {
			generation = (yield* state.storage.get<number>(GENERATION_KEY)) ?? 0;
		}
		return generation;
	});

	const closeStream = (): void => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		if (controller) {
			try {
				controller.close();
			} catch {
				// Already closed.
			}
			controller = undefined;
		}
	};

	const openStream: ConnectionInstance["openStream"] = (input) =>
		Effect.gen(function* () {
			const nextOwner = input.ownerId;
			const nextConnection = input.connectionId;
			// A reconnect on the same connection name bumps the generation so the topic
			// DOs' rows from the prior stream are detected stale on next deliver. The
			// counter is persisted, so a reconnect after eviction still lands on a
			// higher generation than any stale row (no collision/cross-talk).
			const next = (yield* loadGeneration) + 1;
			generation = next;
			yield* state.storage.put(GENERATION_KEY, next);
			ownerId = nextOwner;
			connectionId = nextConnection;
			subscriptions.clear();
			closeStream();

			const stream = new ReadableStream<Uint8Array>({
				cancel: () => closeStream(),
				start: (c) => {
					controller = c;
					c.enqueue(encoder.encode(": connected\n\n"));
					heartbeat = setInterval(() => {
						if (!controller) {
							return;
						}
						try {
							controller.enqueue(encoder.encode(": heartbeat\n\n"));
						} catch {
							closeStream();
						}
					}, 25_000);
				},
			});
			return HttpServerResponse.fromWeb(new Response(stream, {headers: SSE_HEADERS}));
		});

	const subscribe: ConnectionInstance<SR>["subscribe"] = (input) =>
		Effect.gen(function* () {
			// A control message cannot subscribe on another user's behalf.
			if ((ownerId ?? undefined) !== (input.ownerId ?? undefined)) {
				return {ok: false};
			}
			const id = connectionId;
			if (id === undefined) {
				// No open stream / unknown connection name — nothing to register under.
				return {ok: false};
			}
			const topics = topicsForSubscribe(input.control);
			subscriptions.set(input.control.subId, {topics});
			const gen = yield* loadGeneration;
			yield* Effect.forEach(
				topics,
				(topicKey) =>
					Effect.gen(function* () {
						// Lazy sibling resolution happens inside `resolveTopic` (the inline
						// DO does `yield* TopicDO` there) — never in init.
						const topic = yield* resolveTopic(topicKey);
						yield* topic.register({connectionId: id, subId: input.control.subId, generation: gen});
					}),
				{concurrency: "unbounded"},
			);
			return {ok: true};
		});

	const unsubscribe: ConnectionInstance<SR>["unsubscribe"] = (input) =>
		Effect.gen(function* () {
			const sub = subscriptions.get(input.subId);
			if (!sub) {
				return {ok: true} as const;
			}
			subscriptions.delete(input.subId);
			const id = connectionId;
			if (id === undefined) {
				return {ok: true} as const;
			}
			yield* Effect.forEach(
				sub.topics,
				(topicKey) =>
					Effect.gen(function* () {
						const topic = yield* resolveTopic(topicKey);
						yield* topic.deregister({connectionId: id, subId: input.subId});
					}),
				{concurrency: "unbounded"},
			);
			return {ok: true} as const;
		});

	const deliver: ConnectionInstance["deliver"] = (input) =>
		Effect.gen(function* () {
			const current = yield* loadGeneration;
			// Stale: the row was registered by an earlier stream generation, or this
			// connection has no open stream. Report the current generation so the topic
			// DO can prune the row.
			if (input.generation !== current || !controller) {
				return {delivered: false, generation: current};
			}
			// Only deliver if the subscription is still active on this connection.
			if (!subscriptions.has(input.frame.id)) {
				return {delivered: false, generation: current};
			}
			try {
				controller.enqueue(encoder.encode(encodeFrame(input.frame)));
			} catch {
				closeStream();
				return {delivered: false, generation: current};
			}
			return {delivered: true, generation: current};
		});

	const probe: ConnectionInstance["probe"] = () =>
		Effect.map(loadGeneration, (g) => ({generation: g}));

	return {openStream, subscribe, unsubscribe, deliver, probe};
};

// ---------------------------------------------------------------------------
// TopicDO instance
// ---------------------------------------------------------------------------

const CREATE_SUBSCRIBERS_TABLE = `CREATE TABLE IF NOT EXISTS subscribers (
	connectionId TEXT NOT NULL,
	subId TEXT NOT NULL,
	generation INTEGER NOT NULL,
	updatedAt INTEGER NOT NULL,
	misses INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (connectionId, subId)
)`;

/**
 * Build the topic-role DO's per-instance methods.
 *
 * `state` is the resolved `Cloudflare.DurableObjectState` for this instance.
 * `resolveConnection` is the **lazy** sibling resolver — the inline DO passes a
 * thunk that does `yield* ConnectionDO` *inside* `publish`/`alarm` (never in
 * init). The subscriber registry lives in `state.storage.sql`, addressed back to
 * a connection by `getByName(\`connection:${row.connectionId}\`)`.
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

	const ensureTable = exec(CREATE_SUBSCRIBERS_TABLE);

	const loadSubscriberRows = Effect.flatMap(
		state.storage.sql.exec<SubscriberRow>(
			`SELECT connectionId, subId, generation, updatedAt, misses FROM subscribers`,
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
			yield* ensureTable;
			// A fresh register means the connection is alive, so `misses` starts (and
			// on re-register resets) at 0 — a re-subscribe clears any accrued misses.
			yield* exec(
				`INSERT INTO subscribers (connectionId, subId, generation, updatedAt, misses)
					VALUES (?, ?, ?, ?, 0)
					ON CONFLICT(connectionId, subId) DO UPDATE SET
						generation = excluded.generation,
						updatedAt = excluded.updatedAt,
						misses = 0`,
				row.connectionId,
				row.subId,
				row.generation,
				Date.now(),
			);
			// Keep one alarm running to prune rows whose connection DO has gone away
			// without deregistering (eviction, crash).
			yield* ensureAlarm;
			return {ok: true} as const;
		});

	const deregister: TopicInstance["deregister"] = (input) =>
		Effect.gen(function* () {
			yield* ensureTable;
			yield* deleteRow(input.connectionId, input.subId);
			return {ok: true} as const;
		});

	const publish: TopicInstance<SR>["publish"] = (message) =>
		Effect.gen(function* () {
			yield* ensureTable;
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
						// a number = the connection's reported current generation.
						const result = yield* resolveConnection(row.connectionId).pipe(
							Effect.flatMap((connection) =>
								connection.deliver({frame, generation: row.generation}),
							),
							// Bound the fan-out: an unreachable connection aborts here instead
							// of stalling the (single-threaded) topic DO. ANY failure — a
							// timeout, a failed RPC, or a DO-side defect — is "couldn't reach",
							// not "confirmed stale" (mirrors the legacy try/catch). `catchCause`
							// swallows defects too, so one misbehaving sibling can't crash the
							// whole fan-out.
							Effect.timeout(FANOUT_TIMEOUT_MS),
							Effect.catchCause(() => Effect.succeed<DeliverResult | undefined>(undefined)),
						);
						// A *reachable* connection reporting a different current generation
						// means the stream this row was registered for is gone — prune it.
						const prune =
							result !== undefined && !result.delivered && result.generation !== row.generation;
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
			yield* ensureTable;
			const rows = yield* loadSubscriberRows;
			yield* Effect.forEach(
				rows,
				(row) =>
					Effect.gen(function* () {
						// `/probe` reports the connection's current generation without
						// enqueueing onto its stream. Bounded so a dead connection aborts
						// fast instead of stalling the prune.
						const reported = yield* resolveConnection(row.connectionId).pipe(
							Effect.flatMap((connection) => connection.probe()),
							Effect.timeout(FANOUT_TIMEOUT_MS),
							Effect.map((r): number | undefined => r.generation),
							// ANY failure/defect/timeout → "couldn't reach" (mirrors legacy).
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
						} else if (reported !== row.generation) {
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
