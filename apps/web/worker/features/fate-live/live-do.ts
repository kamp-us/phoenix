/**
 * `LiveDO` — the unified live fan-out Durable Object, a void-aligned rewrite of
 * the split `ConnectionDO`/`TopicDO` pair onto a single class that plays BOTH
 * roles, distinguished by instance-name prefix. This mirrors void's
 * `VoidLiveStreamDurableObject` (`void/dist/runtime/live-server.mjs`): one DO
 * class, KV (not SQLite) storage, a `generation` (per-connection) +`revision`
 * (per-subscription) stale model, and a first-failed-probe reap.
 *
 * **Not yet wired.** This file is additive (PR #12 step 3a): the worker still
 * routes through `ConnectionDO`/`TopicDO`. The route/index rewiring and the
 * old-DO removal land in the next step. Importing this Tag pulls in no DO
 * runtime (the bundler tree-shakes `.make()` out of consumers).
 *
 * ## One class, two roles, ONE self-namespace
 * A LiveDO instance is named either `connection:<connectionId>` (connection
 * role: owns one client's held SSE stream + its subscription list) or
 * `topic:<topicKey>` (topic role: owns that topic's durable subscriber registry
 * + the publish fan-out + the reap alarm). {@link resolveRole} reads
 * `state.id.name` to pick the role at request time.
 *
 * Cross-role calls go through the DO's OWN namespace, resolved ONCE in init
 * (`const live = yield* LiveDO`) and held in the closure. Because it is the same
 * class referencing its own namespace, there is no sibling cycle — so unlike the
 * split DOs there is no per-call `yield* Sibling`, and every RPC method's `R`
 * channel is `never`. The Layer requires only `Worker` (the self-namespace is a
 * `DurableObjectService`, excluded from the Layer's requirements by `.make()`).
 *
 * ## KV storage (no SQLite)
 * Storage is `state.storage`'s KV API, mirroring void's flat keys:
 *   - subscriber rows: `sub:${topicKey}:${connectionId}:${subId}:${generation}:${revision}`
 *     → the {@link SubscriberRow} value.
 *   - the per-connection generation scalar: `connection:generation` → a number.
 * Topic-role reads use `state.storage.list({prefix: "sub:${topicKey}:"})`;
 * deletes batch `state.storage.delete(keys)`.
 *
 * ## SSE + reap
 * The connection role holds a `Queue` of frames merged with a 15s keep-alive
 * tick, returned as a streaming `HttpServerResponse` (the one thing kept as
 * `fetch`, not RPC). The topic role schedules a 60s alarm that probes each
 * subscriber's connection via `check`; the FIRST failed/410/404 probe deletes
 * ALL that connection's rows (void-faithful — no consecutive-miss counter).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {DeliverFrame, LiveLimits, SubscriberRow} from "./protocol.ts";
import {encodeFrame, SSE_HEADERS} from "./protocol.ts";

/** Storage key for the persisted per-connection generation counter. */
const GENERATION_KEY = "connection:generation";

/** Reap-alarm cadence: probe each subscriber's connection every 60s. */
const PRUNE_ALARM_DELAY_MS = 60_000;

/** The state value alchemy hands the per-instance Effect (`yield* DurableObjectState`). */
type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

/**
 * The slice of `DurableObjectState` the unified instance builder actually
 * touches: the instance name (`id.name`) and the KV `storage` surface
 * (`get`/`put`/`delete`/`list`/`getAlarm`/`setAlarm`). `makeLiveInstance` is
 * typed against this slice rather than the whole `DurableObjectState` so the
 * node-pool fake (`__support__/do-state.ts`) can satisfy it structurally — no
 * cast — while the real `Cloudflare.DurableObjectState` value still flows in
 * unchanged (it's a superset, so assignable).
 */
export type LiveDoState = Pick<DurableObjectStateValue, "id" | "storage">;

/** A frame delivered to a connection for one of its subscriber rows. */
interface DeliverInput {
	readonly frame: DeliverFrame;
	readonly row: SubscriberRow;
	readonly limits: LiveLimits;
}

/** The result a connection reports for a delivery: whether it landed + staleness. */
interface DeliverResult {
	readonly delivered: boolean;
	readonly stale: boolean;
}

/**
 * The unified LiveDO RPC surface — both roles' typed methods plus the SSE
 * `fetch`. Every method's `R` is `never`: cross-role calls ride the
 * self-namespace captured in init, not a per-call Tag resolution.
 *
 * Connection-role:
 *   - `subscribe` — record a subscription + register it on its topic instance.
 *   - `unsubscribe` — drop a subscription + unregister it on its topic instance.
 *   - `deliver` — enqueue one frame onto the held SSE stream; reports stale.
 *   - `check` — report which of the given rows are stale (probe, no enqueue).
 * Topic-role:
 *   - `register` — persist a subscriber row (KV), bump the reap alarm.
 *   - `unregister` — delete a subscriber row (KV).
 *   - `publish` — fan one message out to every subscriber's connection.
 *
 * A misrouted call (e.g. `register` on a `connection:` instance) hits an
 * instance whose role doesn't match and harmlessly returns an empty/no-op
 * result — void has no role guard either.
 */
export interface LiveRpcSurface {
	readonly subscribe: (input: {
		readonly subId: string;
		readonly topics: ReadonlyArray<string>;
		readonly ownerId: string | undefined;
		readonly limits: LiveLimits;
	}) => Effect.Effect<{readonly ok: boolean}, never, never>;
	readonly unsubscribe: (input: {
		readonly subId: string;
	}) => Effect.Effect<{readonly ok: true}, never, never>;
	readonly deliver: (input: DeliverInput) => Effect.Effect<DeliverResult, never, never>;
	readonly check: (input: {
		readonly subscriptions: ReadonlyArray<SubscriberRow>;
	}) => Effect.Effect<{readonly stale: ReadonlyArray<number>}, never, never>;
	readonly register: (input: {
		readonly row: SubscriberRow;
		readonly limits: LiveLimits;
	}) => Effect.Effect<{readonly ok: boolean}, never, never>;
	readonly unregister: (input: {
		readonly row: SubscriberRow;
	}) => Effect.Effect<{readonly ok: true}, never, never>;
	readonly publish: (input: {
		readonly topicKey: string;
		readonly frame: DeliverFrame;
		readonly limits: LiveLimits;
	}) => Effect.Effect<{readonly delivered: number}, never, never>;
}

/**
 * `LiveDO` Tag — identity plus the {@link LiveRpcSurface} contract callers reach
 * across the stub. No inline body: the runtime is {@link LiveDOLive}.
 */
export class LiveDO extends Cloudflare.DurableObjectNamespace<LiveDO, LiveRpcSurface>()("LiveDO") {}

/**
 * The DO's own namespace handle (`yield* LiveDO`), used in the closure for
 * cross-role addressing. `getByName(name)` returns a typed {@link LiveRpcSurface}
 * stub, so connection→topic and topic→connection calls are fully typed.
 */
type LiveNamespace = Effect.Success<typeof LiveDO>;

/** The role an instance plays, derived from `state.id.name`. */
type Role =
	| {readonly kind: "connection"; readonly connectionId: string}
	| {readonly kind: "topic"; readonly topicKey: string}
	| {readonly kind: "unknown"};

/** Pick the role from the instance name's prefix (void's name convention). */
function resolveRole(name: string | undefined): Role {
	if (name === undefined) {
		return {kind: "unknown"};
	}
	if (name.startsWith("connection:")) {
		return {kind: "connection", connectionId: name.slice("connection:".length)};
	}
	if (name.startsWith("topic:")) {
		return {kind: "topic", topicKey: name.slice("topic:".length)};
	}
	return {kind: "unknown"};
}

/** The flat KV key prefix for one topic's subscriber rows (void-faithful). */
function subscriberPrefix(topicKey: string): string {
	return `sub:${topicKey}:`;
}

/** The flat KV key for one subscriber row (void-faithful). */
function subscriberKey(row: SubscriberRow): string {
	return `${subscriberPrefix(row.topicKey)}${row.connectionId}:${row.subId}:${row.generation}:${row.revision}`;
}

/**
 * Build the unified LiveDO's per-instance methods.
 *
 * `state` is the resolved `Cloudflare.DurableObjectState`. `live` is the DO's own
 * namespace (resolved once in init), used for cross-role addressing:
 * `live.getByName("topic:" + key)` / `live.getByName("connection:" + id)`. The
 * builder takes both as plain args so the same algorithm is unit-testable
 * without workerd.
 */
export const makeLiveInstance = (state: LiveDoState, live: LiveNamespace) => {
	const encoder = new TextEncoder();
	const CONNECTED_FRAME = encoder.encode(": connected\n\n");
	const KEEPALIVE_FRAME = encoder.encode(": keep-alive\n\n");

	const role = resolveRole(state.id.name);

	// ── Connection-role per-instance state (closure-held; the open SSE stream
	// pins this DO in memory). `generation` is the persisted scalar bumped on
	// each (re)connect; `subscriptions` tracks each live subscription's revision
	// + active flag so deliver/check can detect staleness without reaching back.
	let framesQueue: Queue.Queue<Uint8Array> | undefined;
	let ownerId: string | undefined;
	let generation: number | undefined;
	const subscriptions = new Map<
		string,
		{revision: number; active: boolean; topics: ReadonlyArray<string>}
	>();

	const loadGeneration = Effect.gen(function* () {
		if (generation === undefined) {
			generation = (yield* state.storage.get<number>(GENERATION_KEY)) ?? 0;
		}
		return generation;
	});

	const closeStream = Effect.gen(function* () {
		const q = framesQueue;
		if (q !== undefined) {
			framesQueue = undefined;
			yield* Queue.shutdown(q);
		}
	});

	// ── Connection role ─────────────────────────────────────────────────────

	const openStream = (input: {
		readonly ownerId: string | undefined;
		readonly maxQueuedEventsPerConnection: number;
	}) =>
		Effect.gen(function* () {
			// A (re)connect bumps the persisted generation so any subscriber row a
			// topic DO still holds from the prior stream is detected stale on the next
			// deliver/check. The counter survives eviction, so a reconnect after
			// eviction still lands strictly higher than any stale row.
			const next = (yield* loadGeneration) + 1;
			generation = next;
			yield* state.storage.put(GENERATION_KEY, next);
			ownerId = input.ownerId;
			subscriptions.clear();
			yield* closeStream;

			// Bounded at the per-connection backpressure cap with the DROPPING
			// strategy: the queue's own invariant IS the cap, so a stalled SSE reader
			// can buffer at most this many frames. A dropping queue's `Queue.offer`
			// returns false the moment it's full (a `bounded`/suspend queue would
			// instead block the producer — wrong here). `deliver` reads that false to
			// close the connection and report the row stale (void's 410 on queue
			// full). The connected frame counts against the cap.
			const queue = yield* Queue.dropping<Uint8Array>(input.maxQueuedEventsPerConnection);
			framesQueue = queue;
			yield* Queue.offer(queue, CONNECTED_FRAME);

			// 15-second keep-alive cadence. `Stream.tick` emits immediately then on
			// every interval; `drop(1)` skips the immediate tick so the first
			// keep-alive lands at +15s (void's `keepAlive.intervalMs = 15e3`).
			const keepAlive = Stream.tick("15 seconds").pipe(
				Stream.drop(1),
				Stream.map(() => KEEPALIVE_FRAME),
			);
			const frames = Stream.fromQueue(queue);
			const merged = Stream.merge(frames, keepAlive).pipe(Stream.ensuring(closeStream));

			return HttpServerResponse.stream(merged, {headers: SSE_HEADERS});
		});

	/** Is a topic-held subscriber row stale relative to this connection's state? */
	const isStale = (row: SubscriberRow): boolean => {
		if (generation === undefined || row.generation !== generation) {
			return true;
		}
		const subscription = subscriptions.get(row.subId);
		return !subscription?.active || subscription.revision !== row.revision;
	};

	const subscribe: LiveRpcSurface["subscribe"] = (input) =>
		Effect.gen(function* () {
			// A control message cannot subscribe on another user's behalf.
			if (ownerId !== input.ownerId) {
				return {ok: false};
			}
			if (role.kind !== "connection") {
				return {ok: false};
			}
			if (framesQueue === undefined) {
				// No open stream — nothing to register a subscription under.
				return {ok: false};
			}
			// A re-subscribe under the same id bumps its revision; the topic prunes
			// the prior-revision row on register. Cap per-connection subscriptions.
			const existing = subscriptions.get(input.subId);
			if (
				existing === undefined &&
				subscriptions.size >= input.limits.maxSubscriptionsPerConnection
			) {
				return {ok: false};
			}
			const revision = (existing?.revision ?? 0) + 1;
			const gen = yield* loadGeneration;
			subscriptions.set(input.subId, {revision, active: true, topics: input.topics});
			yield* Effect.forEach(
				input.topics,
				(topicKey) =>
					Effect.gen(function* () {
						const row: SubscriberRow = {
							topicKey,
							connectionId: role.connectionId,
							subId: input.subId,
							generation: gen,
							revision,
							updatedAt: Date.now(),
						};
						yield* live.getByName(`topic:${topicKey}`).register({row, limits: input.limits});
					}),
				{concurrency: "unbounded"},
			);
			return {ok: true};
		});

	const unsubscribe: LiveRpcSurface["unsubscribe"] = (input) =>
		Effect.gen(function* () {
			const sub = subscriptions.get(input.subId);
			if (!sub || role.kind !== "connection") {
				return {ok: true} as const;
			}
			sub.active = false;
			subscriptions.delete(input.subId);
			// Eagerly unregister this sub's rows on each topic (void's
			// `unregisterTopic`). Any failure is swallowed best-effort — the reap
			// alarm catches what an unreachable topic instance misses.
			const gen = yield* loadGeneration;
			yield* Effect.forEach(
				sub.topics,
				(topicKey) =>
					live
						.getByName(`topic:${topicKey}`)
						.unregister({
							row: {
								topicKey,
								connectionId: role.connectionId,
								subId: input.subId,
								generation: gen,
								revision: sub.revision,
								updatedAt: Date.now(),
							},
						})
						.pipe(Effect.catchCause(() => Effect.void)),
				{concurrency: "unbounded"},
			);
			return {ok: true} as const;
		});

	const deliver: LiveRpcSurface["deliver"] = (input) =>
		Effect.gen(function* () {
			yield* loadGeneration;
			const queue = framesQueue;
			if (queue === undefined) {
				return {delivered: false, stale: true};
			}
			if (isStale(input.row)) {
				return {delivered: false, stale: true};
			}
			const encoded = encoder.encode(encodeFrame(input.frame));
			if (encoded.byteLength > input.limits.maxEncodedEventSize) {
				// Oversized event: drop it (not stale — the subscription is fine).
				return {delivered: false, stale: false};
			}
			// Backpressure is the bounded queue's own invariant: `offer` returns false
			// when the queue is full (a connection that has fallen too far behind).
			// Close the stream and treat the row as stale (void's 410 on queue full).
			const accepted = yield* Queue.offer(queue, encoded);
			if (!accepted) {
				yield* closeStream;
				return {delivered: false, stale: true};
			}
			return {delivered: true, stale: false};
		});

	const check: LiveRpcSurface["check"] = (input) =>
		Effect.gen(function* () {
			yield* loadGeneration;
			if (framesQueue === undefined) {
				// No open stream — every row this connection was probed for is stale.
				return {stale: input.subscriptions.map((_, index) => index)};
			}
			const stale: Array<number> = [];
			input.subscriptions.forEach((row, index) => {
				if (isStale(row)) {
					stale.push(index);
				}
			});
			return {stale};
		});

	// ── Topic role ──────────────────────────────────────────────────────────

	const loadRows = (topicKey: string) =>
		Effect.map(state.storage.list<SubscriberRow>({prefix: subscriberPrefix(topicKey)}), (map) => [
			...map,
		]);

	/** Group a topic's `[key, row]` entries by `connectionId` for per-connection passes. */
	const groupByConnection = (entries: ReadonlyArray<readonly [string, SubscriberRow]>) => {
		const grouped = new Map<string, Array<{key: string; row: SubscriberRow}>>();
		for (const [key, row] of entries) {
			const list = grouped.get(row.connectionId) ?? [];
			list.push({key, row});
			grouped.set(row.connectionId, list);
		}
		return grouped;
	};

	const ensureAlarm = Effect.gen(function* () {
		const existing = yield* state.storage.getAlarm();
		if (existing == null) {
			yield* state.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS);
		}
	});

	const register: LiveRpcSurface["register"] = (input) =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return {ok: false};
			}
			const row = input.row;
			const entries = yield* loadRows(row.topicKey);
			// Supersede this connection's older rows (lower generation) and the
			// prior-revision row for this exact subscription — void's register prune.
			const stale: Array<string> = [];
			for (const [key, value] of entries) {
				if (value.connectionId === row.connectionId && value.generation < row.generation) {
					stale.push(key);
					continue;
				}
				if (value.connectionId === row.connectionId && value.subId === row.subId) {
					stale.push(key);
				}
			}
			const survivors = entries.filter(([key]) => !stale.includes(key));
			// Topic subscription cap (void returns 409 "topic full"; here a no-op
			// `{ok: false}` is the equivalent rejection — the connection records it).
			if (survivors.length >= input.limits.maxSubscriptionsPerTopic) {
				return {ok: false};
			}
			if (stale.length > 0) {
				yield* state.storage.delete(stale);
			}
			yield* state.storage.put(subscriberKey(row), row);
			yield* ensureAlarm;
			return {ok: true};
		});

	const unregister: LiveRpcSurface["unregister"] = (input) =>
		Effect.gen(function* () {
			yield* state.storage.delete(subscriberKey(input.row));
			return {ok: true} as const;
		});

	const publish: LiveRpcSurface["publish"] = (input) =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return {delivered: 0};
			}
			const entries = yield* loadRows(input.topicKey);
			// Group rows by connection so each connection sees one deliver pass.
			const grouped = groupByConnection(entries);
			// Connections are independent — fan out the per-connection deliver passes
			// concurrently (subscribe/unsubscribe already do). Each pass returns how
			// many of its rows were delivered; the inner per-row loop stays sequential
			// because it short-circuits on the first unreachable item.
			const perConnection = yield* Effect.forEach(
				grouped,
				([connectionId, items]) =>
					Effect.gen(function* () {
						const connection = live.getByName(`connection:${connectionId}`);
						const staleKeys: Array<string> = [];
						let reachable = true;
						let delivered = 0;
						for (const item of items) {
							// Any failure/defect/timeout on the cross-role deliver = "couldn't
							// reach"; void deletes ALL that connection's rows on a 410/404/no
							// response. We mirror that by reaping the whole group when the call
							// fails (the first item to fail flips `reachable`).
							const result = yield* connection
								.deliver({
									frame: {...input.frame, id: item.row.subId},
									row: item.row,
									limits: input.limits,
								})
								.pipe(
									Effect.timeout(input.limits.deliveryAttemptTimeoutMs),
									// @effect-diagnostics-next-line effect/effectSucceedWithVoid:off
									Effect.catchCause(() => Effect.succeed<DeliverResult | undefined>(undefined)),
								);
							if (result === undefined) {
								reachable = false;
								break;
							}
							if (result.delivered) {
								delivered += 1;
							} else if (result.stale) {
								staleKeys.push(item.key);
							}
						}
						if (!reachable) {
							// Unreachable connection: reap ALL its rows for this topic.
							yield* state.storage.delete(items.map((item) => item.key));
						} else if (staleKeys.length > 0) {
							yield* state.storage.delete(staleKeys);
						}
						return delivered;
					}),
				{concurrency: "unbounded"},
			);
			return {delivered: perConnection.reduce((sum, n) => sum + n, 0)};
		});

	const alarm = () =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return;
			}
			const entries = yield* loadRows(role.topicKey);
			const grouped = groupByConnection(entries);
			const probeTimeout = 1_500;
			// Probe each connection concurrently (they're independent); each returns
			// the stale keys it owns, which we flatten and reap in one delete.
			const perConnection = yield* Effect.forEach(
				grouped,
				([connectionId, items]) =>
					Effect.gen(function* () {
						// First failed probe → reap ALL that connection's rows (void-faithful:
						// no consecutive-miss counter). A reachable connection reports which
						// of its rows are stale; we reap exactly those.
						const result = yield* live
							.getByName(`connection:${connectionId}`)
							.check({subscriptions: items.map((item) => item.row)})
							.pipe(
								Effect.timeout(probeTimeout),
								// @effect-diagnostics-next-line effect/effectSucceedWithVoid:off
								Effect.catchCause(() =>
									Effect.succeed<{readonly stale: ReadonlyArray<number>} | undefined>(undefined),
								),
							);
						if (result === undefined) {
							return items.map((item) => item.key);
						}
						const keys: Array<string> = [];
						for (const index of result.stale) {
							const item = items[index];
							if (item) {
								keys.push(item.key);
							}
						}
						return keys;
					}),
				{concurrency: "unbounded"},
			);
			const staleKeys = perConnection.flat();
			if (staleKeys.length > 0) {
				yield* state.storage.delete(staleKeys);
			}
			// Reschedule while rows remain so an evicted connection's orphans are
			// eventually reaped even with no publish traffic.
			const remaining = yield* loadRows(role.topicKey);
			if (remaining.length > 0) {
				yield* state.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS);
			}
		});

	return {
		openStream,
		subscribe,
		unsubscribe,
		deliver,
		check,
		register,
		unregister,
		publish,
		alarm,
	};
};

/**
 * The `LiveDO` implementation Layer. The DO's OWN namespace is resolved once in
 * init from `Cloudflare.DurableObjectNamespaceScope` (the local, scriptName-less
 * self-binding `.make()` provides) and captured in the closure for cross-role
 * addressing — void's `this.env[binding]` pattern. Because it is the local
 * binding (not a cross-script `.from(scriptName)` reference) it works under
 * `alchemy dev`, requires only `Worker`, and every RPC method's `R` is `never`.
 */
export const LiveDOLive = LiveDO.make(
	Effect.gen(function* () {
		// ── SHARED INIT (once per namespace) ──
		// Resolve the DO's OWN namespace here (not per call) for cross-role
		// addressing. This is void's `this.env[bindingName]` self-reference: the
		// `DurableObjectNamespaceScope` is the LOCAL, scriptName-less namespace that
		// `.make()` binds and provides into this init effect (alchemy resolves it
		// from `env[<binding>]` at runtime). It is the right handle for a DO calling
		// its own siblings.
		//
		// Why NOT `LiveDO.from("phoenix")`: every `.from(...)` overload sets a
		// `scriptName` (the string directly, or the worker's name), which declares a
		// CROSS-SCRIPT binding. Under `alchemy dev` that routes through the
		// dev-registry proxy and dies with `Worker "phoenix" not found` — a DO
		// reaching its own siblings must use the local binding, not a cross-worker
		// reference. `DurableObjectNamespaceScope` is provided by `.make()`, so it
		// adds no requirement to the Layer (still `Layer<LiveDO, never, Worker>`);
		// a bare `yield* LiveDO` would instead leak `LiveDO` as an unsatisfiable
		// self-requirement (the very Tag this Layer outputs).
		//
		// The scope is typed generically as `DurableObjectNamespace<unknown>`
		// (alchemy can't know each host's DO shape), so we widen it once to this
		// DO's own statically-known `LiveRpcSurface` contract. This is a pure type
		// widening of an infrastructure handle — there is no runtime value to decode
		// — and it is the only `as` in this file.
		const live = (yield* Cloudflare.DurableObjectNamespaceScope) as LiveNamespace;
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			// ── PER-INSTANCE (once per instance wake) ──
			const state = yield* Cloudflare.DurableObjectState;
			const instance = makeLiveInstance(state, live);
			return {
				// The SSE upgrade stays a `fetch` (request-shaped). Read `ownerId` off
				// the inbound request and open the held stream.
				fetch: Effect.gen(function* () {
					const raw = yield* Cloudflare.Request;
					const url = new URL(raw.url);
					// The route threads the per-request queue cap on the URL (alongside
					// `ownerId`); it sizes the connection's dropping frame queue. Fall
					// back to a safe default if the param is missing/unparseable.
					const capParam = Number(url.searchParams.get("maxQueuedEventsPerConnection"));
					const maxQueuedEventsPerConnection =
						Number.isInteger(capParam) && capParam > 0 ? capParam : 100;
					return yield* instance.openStream({
						ownerId: url.searchParams.get("ownerId") ?? undefined,
						maxQueuedEventsPerConnection,
					});
				}),
				subscribe: instance.subscribe,
				unsubscribe: instance.unsubscribe,
				deliver: instance.deliver,
				check: instance.check,
				register: instance.register,
				unregister: instance.unregister,
				publish: instance.publish,
				alarm: instance.alarm,
			};
		});
	}),
);
