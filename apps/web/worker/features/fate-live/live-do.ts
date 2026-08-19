/**
 * `LiveDO` — the unified live fan-out Durable Object. One class plays both roles,
 * picked from the instance name: `connection:<id>` (one client's held SSE stream)
 * or `topic:<key>` (subscriber registry + publish fan-out + reap alarm). Address
 * instances only via {@link connectionOf}/{@link topicOf}. See ADR 0037 (unified
 * DO, storage/stale model) and ADR 0124 (self-namespace resolution).
 */
import type {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {BufferedFrame, DeliverFrame, LiveLimits, SubscriberRow} from "./protocol.ts";
import {defaultLiveLimits, encodeFrame, SSE_HEADERS} from "./protocol.ts";

const GENERATION_KEY = "connection:generation";

// Persisted (not just closure-held) so the foreign-re-open fence in `openStream`
// survives eviction (#2563).
const OWNER_KEY = "connection:owner";

const BUFFER_SEQ_KEY = "topic:buffer:seq";

const PRUNE_ALARM_DELAY_MS = 60_000;

// The platform-fired `alarm()` has no worker call to thread `LiveLimits` through, so
// the last `register` persists its probe budget here rather than the DO inventing one.
// See ADR 0037.
const REAP_PROBE_TIMEOUT_KEY = "topic:reap:probe-timeout-ms";

type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

// A slice, not the whole `DurableObjectState`, so the node-pool fake
// (`do-state.testing.ts`) satisfies it structurally with no cast.
export type LiveDoState = Pick<DurableObjectStateValue, "id" | "storage">;

interface DeliverInput {
	readonly frame: DeliverFrame;
	readonly row: SubscriberRow;
	readonly limits: LiveLimits;
}

interface DeliverResult {
	readonly delivered: boolean;
	readonly stale: boolean;
}

// Both roles' methods on one surface. Every method no-ops without touching storage
// when called against the wrong role — unreachable in production (addressing always
// matches), kept total so a refactor cannot break it. See ADR 0037.
export interface LiveRpcSurface {
	readonly subscribe: (input: {
		readonly subId: string;
		readonly topics: ReadonlyArray<string>;
		readonly ownerId: string | undefined;
		readonly limits: LiveLimits;
		readonly lastEventId?: string;
	}) => Effect.Effect<{readonly ok: boolean}, never, RuntimeContext>;
	readonly unsubscribe: (input: {
		readonly subId: string;
	}) => Effect.Effect<{readonly ok: true}, never, RuntimeContext>;
	readonly deliver: (input: DeliverInput) => Effect.Effect<DeliverResult, never, RuntimeContext>;
	readonly check: (input: {
		readonly subscriptions: ReadonlyArray<SubscriberRow>;
	}) => Effect.Effect<{readonly stale: ReadonlyArray<number>}, never, RuntimeContext>;
	readonly register: (input: {
		readonly row: SubscriberRow;
		readonly limits: LiveLimits;
		readonly subscribedAt: number;
		// The replay floor, fencing pre-epoch frames (#1072/#1903). Optional so a direct
		// `register` (tests) with no epoch falls back to the `subscribedAt` bound.
		readonly epochStartedAt?: number;
		readonly lastEventId?: string;
	}) => Effect.Effect<{readonly ok: boolean}, never, RuntimeContext>;
	readonly unregister: (input: {
		readonly row: SubscriberRow;
	}) => Effect.Effect<{readonly ok: true}, never, RuntimeContext>;
	readonly publish: (input: {
		readonly topicKey: string;
		readonly frame: DeliverFrame;
		readonly limits: LiveLimits;
	}) => Effect.Effect<{readonly delivered: number}, never, RuntimeContext>;
}

export class LiveDO extends Cloudflare.DurableObject<LiveDO, LiveRpcSurface>()("LiveDO") {}

type LiveNamespace = Effect.Success<typeof LiveDO>;

type Role =
	| {readonly kind: "connection"; readonly connectionId: string}
	| {readonly kind: "topic"; readonly topicKey: string}
	| {readonly kind: "unknown"};

const CONNECTION_PREFIX = "connection:";
const TOPIC_PREFIX = "topic:";

// Never call the name builders directly — address via `connectionOf`/`topicOf`. That
// is a convention, not a compiler guarantee: `getByName` takes any string, and a
// malformed name resolves to the `unknown` role (a silently no-op RPC).
export const makeConnectionName = (connectionId: string): `connection:${string}` =>
	`${CONNECTION_PREFIX}${connectionId}`;

export const makeTopicName = (topicKey: string): `topic:${string}` => `${TOPIC_PREFIX}${topicKey}`;

export const connectionOf = <T>(
	live: {readonly getByName: (name: string) => T},
	connectionId: string,
): T => live.getByName(makeConnectionName(connectionId));

export const topicOf = <T>(live: {readonly getByName: (name: string) => T}, topicKey: string): T =>
	live.getByName(makeTopicName(topicKey));

function resolveRole(name: string | undefined): Role {
	if (name === undefined) {
		return {kind: "unknown"};
	}
	if (name.startsWith(CONNECTION_PREFIX)) {
		return {kind: "connection", connectionId: name.slice(CONNECTION_PREFIX.length)};
	}
	if (name.startsWith(TOPIC_PREFIX)) {
		return {kind: "topic", topicKey: name.slice(TOPIC_PREFIX.length)};
	}
	return {kind: "unknown"};
}

function subscriberPrefix(topicKey: string): string {
	return `sub:${topicKey}:`;
}

function subscriberKey(row: SubscriberRow): string {
	return `${subscriberPrefix(row.topicKey)}${row.connectionId}:${row.subId}:${row.generation}:${row.revision}`;
}

function bufferPrefix(topicKey: string): string {
	return `frame:${topicKey}:`;
}

// `seq` is zero-padded because KV `list({prefix})` sorts by key string, not by the
// numeric `seq` — replay must hand frames back in publish order.
function bufferKey(topicKey: string, seq: number): string {
	return `${bufferPrefix(topicKey)}${seq.toString().padStart(20, "0")}`;
}

// `state` and the DO's own namespace come in as plain args so the algorithm is
// unit-testable without workerd.
export const makeLiveInstance = (state: LiveDoState, live: LiveNamespace) => {
	const encoder = new TextEncoder();
	const CONNECTED_FRAME = encoder.encode(": connected\n\n");
	const KEEPALIVE_FRAME = encoder.encode(": keep-alive\n\n");

	const role = resolveRole(state.id.name);

	// Closure-held connection-role state; the open SSE stream pins this DO in memory.
	let framesQueue: Queue.Queue<Uint8Array> | undefined;
	let ownerId: string | undefined;
	let generation: number | undefined;
	// Instant this connection's current epoch began. The replay floor: a pre-epoch frame
	// is already in a cursorless reconnect's query result, so replaying it would clobber
	// the fresh value. See {@link replayBuffer} (#1072/#1903).
	let epochStartedAt: number | undefined;
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

	// Read from storage on first miss: the closure var is undefined on a fresh wake, and
	// the open-time fence (#2563) must still hold after eviction.
	const loadOwner = Effect.gen(function* () {
		if (ownerId === undefined) {
			ownerId = yield* state.storage.get<string>(OWNER_KEY);
		}
		return ownerId;
	});

	const closeStream = Effect.gen(function* () {
		const q = framesQueue;
		if (q !== undefined) {
			framesQueue = undefined;
			yield* Queue.shutdown(q);
		}
	});

	const openStream = (input: {
		readonly ownerId: string | undefined;
		readonly maxQueuedEventsPerConnection: number;
	}) =>
		Effect.gen(function* () {
			if (role.kind !== "connection") {
				return HttpServerResponse.empty({status: 404});
			}
			// Owner fence on OPEN (#2563): refuse a foreign re-open before touching
			// anything — no generation bump, no owner overwrite, no subscription clear, no
			// teardown. `subscribe`'s owner check runs too late; a hostile re-open had
			// already reset the holder by then.
			const boundOwner = yield* loadOwner;
			if (boundOwner !== undefined && boundOwner !== input.ownerId) {
				return HttpServerResponse.empty({status: 403});
			}
			// Persisted, so a reconnect after eviction still lands strictly higher than any
			// subscriber row a topic DO still holds from the prior stream.
			const next = (yield* loadGeneration) + 1;
			generation = next;
			epochStartedAt = Date.now();
			yield* state.storage.put(GENERATION_KEY, next);
			ownerId = input.ownerId;
			if (input.ownerId !== undefined) {
				yield* state.storage.put(OWNER_KEY, input.ownerId);
			}
			subscriptions.clear();
			yield* closeStream;

			// Dropping, not bounded: `offer` must return false instead of blocking the
			// producer, so `deliver` can close the connection and report the row stale.
			const queue = yield* Queue.dropping<Uint8Array>(input.maxQueuedEventsPerConnection);
			framesQueue = queue;
			yield* Queue.offer(queue, CONNECTED_FRAME);

			// `drop(1)` skips `Stream.tick`'s immediate tick so the first keep-alive
			// lands at +15s, not 0.
			const keepAlive = Stream.tick("15 seconds").pipe(
				Stream.drop(1),
				Stream.map(() => KEEPALIVE_FRAME),
			);
			const frames = Stream.fromQueue(queue);
			const merged = Stream.merge(frames, keepAlive).pipe(Stream.ensuring(closeStream));

			return HttpServerResponse.stream(merged, {headers: SSE_HEADERS});
		});

	const isStale = (row: SubscriberRow): boolean => {
		if (generation === undefined || row.generation !== generation) {
			return true;
		}
		const subscription = subscriptions.get(row.subId);
		return !subscription?.active || subscription.revision !== row.revision;
	};

	const subscribe: LiveRpcSurface["subscribe"] = (input) =>
		Effect.gen(function* () {
			// One reading shared across all this call's topics: it bounds replay to the
			// register-race window (#714), never the topic's prior history.
			const subscribedAt = Date.now();
			// A control message cannot subscribe on another user's behalf.
			if (ownerId !== input.ownerId) {
				return {ok: false};
			}
			if (role.kind !== "connection") {
				return {ok: false};
			}
			if (framesQueue === undefined) {
				return {ok: false};
			}
			// A re-subscribe under the same id bumps its revision; the topic prunes
			// the prior-revision row on register.
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
						// The three replay bounds the topic needs; see {@link replayBuffer}.
						yield* topicOf(live, topicKey).register({
							row,
							limits: input.limits,
							subscribedAt,
							...(epochStartedAt !== undefined ? {epochStartedAt} : {}),
							...(input.lastEventId !== undefined ? {lastEventId: input.lastEventId} : {}),
						});
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
			// Failure is swallowed on purpose: the reap alarm catches what an unreachable
			// topic instance misses.
			const gen = yield* loadGeneration;
			yield* Effect.forEach(
				sub.topics,
				(topicKey) =>
					topicOf(live, topicKey)
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
			// A full dropping queue means the client fell behind: tear the stream down and
			// report the row stale.
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

	const loadRows = (topicKey: string) =>
		Effect.map(state.storage.list<SubscriberRow>({prefix: subscriberPrefix(topicKey)}), (map) => [
			...map,
		]);

	const groupByConnection = (entries: ReadonlyArray<readonly [string, SubscriberRow]>) => {
		const grouped = new Map<string, Array<{key: string; row: SubscriberRow}>>();
		for (const [key, row] of entries) {
			const list = grouped.get(row.connectionId) ?? [];
			list.push({key, row});
			grouped.set(row.connectionId, list);
		}
		return grouped;
	};

	const ensureAlarm = (limits: LiveLimits) =>
		Effect.gen(function* () {
			// See {@link REAP_PROBE_TIMEOUT_KEY}.
			yield* state.storage.put(REAP_PROBE_TIMEOUT_KEY, limits.deliveryAttemptTimeoutMs);
			const existing = yield* state.storage.getAlarm();
			if (existing == null) {
				yield* state.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS);
			}
		});

	const loadBuffer = (topicKey: string) =>
		Effect.map(state.storage.list<BufferedFrame>({prefix: bufferPrefix(topicKey)}), (map) => [
			...map,
		]);

	// Runs on every publish and register, so the ring stays bounded with no background
	// sweep. `now` is passed in so one clock reading covers prune + append.
	const pruneBuffer = (
		entries: ReadonlyArray<readonly [string, BufferedFrame]>,
		limits: LiveLimits,
		now: number,
	) =>
		Effect.gen(function* () {
			const unexpired = entries.filter(([, value]) => now - value.at <= limits.bufferedFrameTtlMs);
			// `entries` is lexically ordered (zero-padded seq), so the newest are the tail.
			const overCap = Math.max(0, unexpired.length - limits.maxBufferedFramesPerTopic);
			const expired = entries.filter(([, value]) => now - value.at > limits.bufferedFrameTtlMs);
			const dropKeys = [
				...expired.map(([key]) => key),
				...unexpired.slice(0, overCap).map(([key]) => key),
			];
			if (dropKeys.length > 0) {
				yield* state.storage.delete(dropKeys);
			}
			return unexpired.slice(overCap);
		});

	const nextSeq = Effect.gen(function* () {
		const seq = ((yield* state.storage.get<number>(BUFFER_SEQ_KEY)) ?? 0) + 1;
		yield* state.storage.put(BUFFER_SEQ_KEY, seq);
		return seq;
	});

	// The frame arrives already seq-stamped: the caller stamped `eventId` before fan-out,
	// so the buffered copy carries the same ordinal the client saw on the wire and replay
	// resumes against it exactly.
	const appendToBuffer = (
		topicKey: string,
		frame: DeliverFrame,
		seq: number,
		limits: LiveLimits,
		now: number,
	) =>
		Effect.gen(function* () {
			const entries = yield* loadBuffer(topicKey);
			yield* pruneBuffer(entries, limits, now);
			const buffered: BufferedFrame = {seq, eventId: frame.eventId, at: now, frame};
			yield* state.storage.put(bufferKey(topicKey, seq), buffered);
		});

	/**
	 * Replay the catch-up window to a connection whose `register` lost the race with
	 * a just-fired publish (#714).
	 *
	 * Bounded to the register-race window, NOT the whole TTL buffer, by the CAUSAL epoch
	 * floor `epochStartedAt` (the instant `openStream` began this connection's current epoch,
	 * #1072/#1903): replay delivers only frames published at/after the epoch. A #714
	 * register-race frame fires after `openStream` (`at >= epochStartedAt`) so it still
	 * replays; a stale pre-vote frame from before the subscribe intent is pre-epoch
	 * (`at < epochStartedAt`) and is dropped, so it can't clobber the correct post-reload
	 * value on a cursorless fresh-subscribe (that pre-epoch frame carries the CURRENT
	 * generation once replayed, so `isStale` alone doesn't catch it — the floor must). The
	 * `subscribedAt` fallback covers only the epoch-absent direct-`register` (test) path.
	 * `lastEventId` tightens further on a cursored resubscribe (skip frames at/under the id
	 * already seen); the epoch floor applies even with no cursor.
	 *
	 * Dedup guarantee — at-most-once, exclusive-by-construction: fan-out (`publish`)
	 * delivers ONLY to connections already in the registry; replay delivers ONLY to
	 * the connection that is registering NOW — which fan-out could not have reached,
	 * because its row was not yet persisted when that publish listed the registry. So
	 * the two delivery paths are disjoint by the order of the race itself; a frame is
	 * never sent to one connection by both. The fate native client is *also*
	 * idempotent under node id — `insertConnectionEdge` strips any prior occurrence
	 * before each insert — so even an unforeseen overlap collapses to a single edge,
	 * never a duplicate (verified in fate's `client.ts`).
	 */
	const replayBuffer = (
		row: SubscriberRow,
		limits: LiveLimits,
		subscribedAt: number,
		epochStartedAt: number | undefined,
		lastEventId: string | undefined,
	) =>
		Effect.gen(function* () {
			const now = Date.now();
			const entries = yield* loadBuffer(row.topicKey);
			const window = yield* pruneBuffer(entries, limits, now);
			// No wall-clock grace here: `epochStartedAt` and `subscribedAt` come off the same
			// connection-DO clock, so there is no skew to absorb — and the grace was itself
			// the #1903 leak.
			const floor = epochStartedAt ?? subscribedAt;
			// Compare the cursor numerically against `buffered.seq` and replay only strictly
			// newer frames. A string-equality scan would never find a cursor frame that had
			// aged out of the window, and would then wrongly drop everything newer (#731).
			const cursorSeq = lastEventId === undefined ? undefined : Number(lastEventId);
			const sinceSeq =
				cursorSeq !== undefined && Number.isFinite(cursorSeq) ? cursorSeq : undefined;
			const connection = connectionOf(live, row.connectionId);
			for (const [, buffered] of window) {
				if (buffered.at < floor) {
					continue;
				}
				if (sinceSeq !== undefined && buffered.seq <= sinceSeq) {
					continue;
				}
				yield* connection
					.deliver({
						frame: {...buffered.frame, id: row.subId},
						row,
						limits,
					})
					.pipe(
						Effect.timeout(limits.deliveryAttemptTimeoutMs),
						// @effect-diagnostics-next-line effect/effectSucceedWithVoid:off
						Effect.catchCause(() => Effect.succeed<DeliverResult | undefined>(undefined)),
					);
			}
		});

	const register: LiveRpcSurface["register"] = (input) =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return {ok: false};
			}
			const row = input.row;
			const entries = yield* loadRows(row.topicKey);
			// Supersede this connection's older-generation rows and the prior-revision row
			// for this exact subscription.
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
			// Topic full: `{ok: false}` is the rejection, and the connection records it.
			if (survivors.length >= input.limits.maxSubscriptionsPerTopic) {
				return {ok: false};
			}
			if (stale.length > 0) {
				yield* state.storage.delete(stale);
			}
			yield* state.storage.put(subscriberKey(row), row);
			yield* ensureAlarm(input.limits);
			// Catch up on frames a publish that beat this register would have missed
			// (#714) — see {@link replayBuffer}.
			yield* replayBuffer(
				row,
				input.limits,
				input.subscribedAt,
				input.epochStartedAt,
				input.lastEventId,
			);
			return {ok: true};
		});

	const unregister: LiveRpcSurface["unregister"] = (input) =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return {ok: true} as const;
			}
			yield* state.storage.delete(subscriberKey(input.row));
			return {ok: true} as const;
		});

	const publish: LiveRpcSurface["publish"] = (input) =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return {delivered: 0};
			}
			// Stamp the ordinal BEFORE fan-out so the live frame, the buffered copy, and
			// every replay carry the same SSE `id:` and last-frame-wins stays correct
			// (#731). The topic owns the id and overrides any inbound one.
			const seq = yield* nextSeq;
			const frame: DeliverFrame = {...input.frame, eventId: String(seq)};
			const entries = yield* loadRows(input.topicKey);
			// Connections fan out concurrently; the inner per-row loop stays sequential
			// because it short-circuits on the first unreachable item.
			const grouped = groupByConnection(entries);
			const perConnection = yield* Effect.forEach(
				grouped,
				([connectionId, items]) =>
					Effect.gen(function* () {
						const connection = connectionOf(live, connectionId);
						const staleKeys: Array<string> = [];
						let reachable = true;
						let delivered = 0;
						for (const item of items) {
							// Any failure, defect or timeout counts as unreachable and reaps ALL
							// that connection's rows, not just this one.
							const result = yield* connection
								.deliver({
									frame: {...frame, id: item.row.subId},
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
							yield* state.storage.delete(items.map((item) => item.key));
						} else if (staleKeys.length > 0) {
							yield* state.storage.delete(staleKeys);
						}
						return delivered;
					}),
				{concurrency: "unbounded"},
			);
			// After fan-out, and the same seq-stamped frame, so a subscriber whose register
			// lands later replays exactly what went out live (#714).
			yield* appendToBuffer(input.topicKey, frame, seq, input.limits, Date.now());
			return {delivered: perConnection.reduce((sum, n) => sum + n, 0)};
		});

	const alarm = () =>
		Effect.gen(function* () {
			if (role.kind !== "topic") {
				return;
			}
			const entries = yield* loadRows(role.topicKey);
			const grouped = groupByConnection(entries);
			// See {@link REAP_PROBE_TIMEOUT_KEY}; the shared default covers the case where no
			// row has armed the alarm yet.
			const probeTimeout =
				(yield* state.storage.get<number>(REAP_PROBE_TIMEOUT_KEY)) ??
				defaultLiveLimits.deliveryAttemptTimeoutMs;
			const perConnection = yield* Effect.forEach(
				grouped,
				([connectionId, items]) =>
					Effect.gen(function* () {
						// One failed probe reaps ALL that connection's rows — no
						// consecutive-miss counter. A reachable connection instead names its
						// own stale rows, and only those go.
						const result = yield* connectionOf(live, connectionId)
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
			// Reschedule while rows remain, so an evicted connection's orphans are reaped
			// even with no publish traffic.
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

// See ADR 0028 (the DO model) and ADR 0124 (self-namespace resolution).
export const LiveDOLive = LiveDO.make(
	Effect.gen(function* () {
		// Must be the OUTER init, not a handler: `.make` provides `DurableObjectScope` to
		// the constructor (alchemy DurableObject.js:640) but does not thread it into the
		// inner handlers, so a handler-level yield dies at runtime. Not `LiveDO.from(Self)`
		// either — that needs the host `Worker` and reintroduces the worker↔DO cycle. The
		// double cast is the only spelling that discharges the phantom `Req`, since
		// `DurableObjectClass` and `Effect` do not structurally overlap.
		// biome-ignore lint/plugin: discharges the self-scope `Req` that `.make` provides at runtime (alchemy DurableObject.js:640) but leaves in the type — the beta.59 typing gap ADR 0124 records; no value is fabricated, the runtime yield is unchanged.
		const live = yield* Cloudflare.DurableObject as unknown as Effect.Effect<LiveNamespace>;
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			const instance = makeLiveInstance(state, live);
			return {
				fetch: Effect.gen(function* () {
					const raw = yield* Cloudflare.Request;
					const url = new URL(raw.url);
					const capParam = Number(url.searchParams.get("maxQueuedEventsPerConnection"));
					const maxQueuedEventsPerConnection =
						Number.isInteger(capParam) && capParam > 0
							? capParam
							: defaultLiveLimits.maxQueuedEventsPerConnection;
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
