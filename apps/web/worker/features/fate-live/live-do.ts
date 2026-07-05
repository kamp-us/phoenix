/**
 * `LiveDO` — the unified live fan-out Durable Object (ADR 0037), a void-aligned
 * rewrite of the split `ConnectionDO`/`TopicDO` pair onto ONE class that plays
 * both roles, distinguished by instance-name prefix (mirrors void's
 * `VoidLiveStreamDurableObject`).
 *
 * An instance is named either `connection:<connectionId>` (owns one client's
 * held SSE stream + its subscription list) or `topic:<topicKey>` (owns that
 * topic's durable subscriber registry + publish fan-out + reap alarm).
 * {@link resolveRole} reads `state.id.name` to pick the role at request time;
 * instances are addressed ONLY via {@link connectionOf}/{@link topicOf}.
 *
 * Cross-role calls go through the DO's OWN namespace, resolved once in the outer
 * (per-instance) init and held in the closure. Same class referencing its own
 * namespace = no sibling cycle, so the Layer requires only `Worker` (ADR 0124 —
 * the beta.59 self-namespace resolution). The RPC methods' `R` is `RuntimeContext`
 * (beta.59 colored DO storage + cross-role stubs), discharged at the worker call
 * seam and, in unit tests, via `RuntimeContext.phantom`.
 *
 * Storage is `state.storage`'s flat KV API (no SQLite), void-faithful. The
 * void-faithful stale model rides two counters: per-connection `generation`
 * (bumped on each (re)connect, survives eviction) and per-subscription
 * `revision`. The reap alarm deletes ALL a connection's rows on the FIRST
 * failed probe — no consecutive-miss counter.
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

/** Topic-role: the monotonic per-topic publish ordinal backing the replay buffer. */
const BUFFER_SEQ_KEY = "topic:buffer:seq";

const PRUNE_ALARM_DELAY_MS = 60_000;

/**
 * KV key under which the topic role stamps the probe timeout the request path
 * threaded. The platform-fired `alarm()` has no worker call to thread `LiveLimits`
 * through, so the most recent `register` persists `deliveryAttemptTimeoutMs` here for
 * the alarm to read back — closing the decision-2B hole ("the DO never invents its
 * own", see {@link LiveLimits}) at the alarm seam instead of duplicating the
 * literal. See ADR 0037.
 */
const REAP_PROBE_TIMEOUT_KEY = "topic:reap:probe-timeout-ms";

type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

/**
 * The slice of `DurableObjectState` the instance builder touches: `id.name` +
 * the KV `storage`. Typed against this slice (not the whole `DurableObjectState`)
 * so the node-pool fake (`do-state.testing.ts`) satisfies it structurally with no
 * cast, while the real superset value still flows in unchanged.
 */
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

/**
 * The unified LiveDO RPC surface — both roles' typed methods plus the SSE
 * `fetch`. Each method belongs to one role: connection-role (`openStream`/`fetch`,
 * `subscribe`, `unsubscribe`, `deliver`, `check`) vs topic-role (`register`,
 * `unregister`, `publish`, `alarm`). A misrouted call returns the method's no-op
 * shape WITHOUT mutating storage — and this holds *uniformly*: the topic-role
 * methods early-return on `role.kind !== "topic"`, `openStream`/`subscribe`/
 * `unsubscribe` on `role.kind !== "connection"`, and `deliver`/`check` on the
 * absent connection queue (only a connection's `openStream` sets `framesQueue`).
 * The real invariant is addressing-correctness: production reaches an instance
 * only via {@link connectionOf}/{@link topicOf}, which always target the matching
 * role, so a misroute is unreachable in practice — the role guards make the
 * documented no-op total and refactor-proof rather than convention-only. See
 * ADR 0037.
 */
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
		// Connection-DO internal state (NOT a persisted row/frame field): the instant
		// the subscribing connection's current epoch began. It is the authoritative replay
		// floor, fencing pre-epoch frames (#1072/#1903). Optional so a direct `register`
		// (tests) that doesn't model an epoch falls back to the `subscribedAt` bound.
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

/**
 * Build a connection-role instance name. Production code never calls the name
 * builders directly — addressing goes through {@link connectionOf}/{@link topicOf},
 * so "always address via those, never hand-roll a name" is a greppable convention,
 * NOT a compiler guarantee: `getByName` accepts any string, and a malformed name
 * is what {@link resolveRole} maps to `unknown` (a silently no-op RPC). Exported
 * for `do.test.ts`'s platform fake.
 */
export const makeConnectionName = (connectionId: string): `connection:${string}` =>
	`${CONNECTION_PREFIX}${connectionId}`;

export const makeTopicName = (topicKey: string): `topic:${string}` => `${TOPIC_PREFIX}${topicKey}`;

/**
 * Address a connection-role instance: name grammar + `getByName` in one step.
 * Generic over the namespace's structural shape, so the worker namespace, the
 * DO's own scope handle, and the test fake all use the same addressing seam.
 */
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

/**
 * The replay-buffer key for one published frame. `seq` is zero-padded so the KV
 * `list({prefix})` lexical order matches publish order (the store sorts by key
 * string, not by the numeric `seq` field) — replay must hand frames back in the
 * order they were published.
 */
function bufferKey(topicKey: string, seq: number): string {
	return `${bufferPrefix(topicKey)}${seq.toString().padStart(20, "0")}`;
}

/**
 * Build the unified LiveDO's per-instance methods. The builder takes `state` and
 * the DO's own namespace `live` (for cross-role addressing) as plain args so the
 * same algorithm is unit-testable without workerd.
 */
export const makeLiveInstance = (state: LiveDoState, live: LiveNamespace) => {
	const encoder = new TextEncoder();
	const CONNECTED_FRAME = encoder.encode(": connected\n\n");
	const KEEPALIVE_FRAME = encoder.encode(": keep-alive\n\n");

	const role = resolveRole(state.id.name);

	// Connection-role per-instance state, closure-held; the open SSE stream pins
	// this DO in memory. `subscriptions` tracks each live subscription's revision
	// + active flag so deliver/check detect staleness without reaching back.
	let framesQueue: Queue.Queue<Uint8Array> | undefined;
	let ownerId: string | undefined;
	let generation: number | undefined;
	// Wall-clock instant this connection's CURRENT epoch began (set when `openStream`
	// bumps `generation`). The authoritative replay floor: a frame published before the
	// epoch — already in a cursorless reconnect's query result — can't leak onto the new
	// stream and clobber it. See {@link replayBuffer} (#1072/#1903).
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
			// A (re)connect bumps the persisted generation so any subscriber row a
			// topic DO still holds from the prior stream is detected stale on the next
			// deliver/check. The counter survives eviction, so a reconnect after
			// eviction still lands strictly higher than any stale row.
			const next = (yield* loadGeneration) + 1;
			generation = next;
			epochStartedAt = Date.now();
			yield* state.storage.put(GENERATION_KEY, next);
			ownerId = input.ownerId;
			subscriptions.clear();
			yield* closeStream;

			// DROPPING strategy (not bounded): `Queue.offer` returns false the moment
			// it's full instead of blocking the producer, and `deliver` reads that
			// false to close the connection + report the row stale (void's 410 on queue
			// full). The connected frame counts against the cap.
			const queue = yield* Queue.dropping<Uint8Array>(input.maxQueuedEventsPerConnection);
			framesQueue = queue;
			yield* Queue.offer(queue, CONNECTED_FRAME);

			// [DIAG2049] stage READ-LOOP-ENTRY — the connection role bound its held-stream
			// queue and is about to build the merged SSE read stream. Proves the subscriber
			// connection entered the read loop (vs erroring before it).
			console.log(
				`[DIAG2049][READ-LOOP-ENTRY] connectionId=${role.connectionId} generation=${generation} epochStartedAt=${epochStartedAt}`,
			);

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
			// The intent timestamp that bounds replay: only frames published at/after
			// this instant catch up (the register-race window of #714), never the
			// topic's prior history. One reading for the whole call, shared across all
			// its topics. See {@link replayBuffer}.
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
						// Thread `subscribedAt` (the primary replay bound), `epochStartedAt`
						// (raises the floor to this connection's current epoch, fencing
						// pre-epoch frames — #1072), and `lastEventId` (an additional
						// tightening on a cursored resubscribe) so the topic replays only
						// frames from this subscriber's current-epoch intent forward (#714).
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
			// Failure here is swallowed best-effort — the reap alarm catches what an
			// unreachable topic instance misses.
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
			// `offer` returns false when the dropping queue is full: close the stream
			// and treat the row as stale (void's 410 on queue full).
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
				// No open stream — every probed row is stale.
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
			// Stamp the threaded probe budget so the platform-fired `alarm()` reaps on the
			// same `deliveryAttemptTimeoutMs` the request path uses (decision 2B), never a
			// DO-invented literal — see {@link REAP_PROBE_TIMEOUT_KEY}.
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

	/**
	 * Drop buffer entries past the TTL or beyond the count cap, returning the
	 * surviving window (newest-last). Called on every publish and register so the ring
	 * stays bounded by both dimensions with no background sweep. `now` is passed so a
	 * caller's clock reading is the single source of truth across prune+append.
	 */
	const pruneBuffer = (
		entries: ReadonlyArray<readonly [string, BufferedFrame]>,
		limits: LiveLimits,
		now: number,
	) =>
		Effect.gen(function* () {
			const unexpired = entries.filter(([, value]) => now - value.at <= limits.bufferedFrameTtlMs);
			// `entries` is lexically ordered (zero-padded seq), so the newest are the
			// tail; drop the oldest overflow past the count cap.
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

	/** Allocate the next monotonic per-topic publish ordinal (persisted). */
	const nextSeq = Effect.gen(function* () {
		const seq = ((yield* state.storage.get<number>(BUFFER_SEQ_KEY)) ?? 0) + 1;
		yield* state.storage.put(BUFFER_SEQ_KEY, seq);
		return seq;
	});

	/**
	 * Append an already-seq-stamped frame to the ring buffer (after a prune). The
	 * caller allocated the `seq` (via {@link nextSeq}) and stamped it onto the frame's
	 * `eventId` BEFORE fan-out, so the live-delivered frame, the buffered frame, and
	 * its `BufferedFrame.eventId` all carry the SAME ordinal — replay resumes against
	 * the exact id the client already saw on the wire.
	 */
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
			// The replay floor is the CAUSAL epoch boundary, not a wall-clock guess: a #714
			// register-race frame is published after `openStream` (`at >= epochStartedAt`, KEEP);
			// a stale pre-vote frame published before the subscribe intent is pre-epoch
			// (`at < epochStartedAt`, DROP). Production always sets `epochStartedAt` (openStream);
			// the `subscribedAt` fallback is only the epoch-absent direct-`register` (test) path.
			// No wall-clock grace: it once absorbed cross-DO skew, but `epochStartedAt` and
			// `subscribedAt` are the SAME connection-DO clock, so there is no skew to absorb — and
			// that grace was itself the #1903 leak (it admitted the pre-vote frame the epoch fence
			// now drops). See #1903.
			const floor = epochStartedAt ?? subscribedAt;
			// The cursor is the last per-topic `seq` the subscriber saw (every delivered frame
			// now carries `eventId === String(seq)`, primary fan-out and replay alike). Compare
			// numerically against `buffered.seq` and replay only STRICTLY-newer frames — robust
			// even when the cursor frame itself has aged out of the window (a string-equality
			// scan would never find it and wrongly drop everything newer). A non-numeric/absent
			// cursor leaves the whole at/after-intent window eligible (#714/#731).
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
			yield* ensureAlarm(input.limits);
			// [DIAG2049] stage REGISTER — the topic role accepted+persisted this subscriber
			// row. Log the topic key it registered under (should be `Definition:<id>` for
			// the reaction subscribe) so REGISTER, PUBLISH, and DRAIN can be keyed together.
			console.log(
				`[DIAG2049][REGISTER] topicKey=${role.topicKey} connectionId=${row.connectionId} subId=${row.subId} generation=${row.generation} revision=${row.revision} epochStartedAt=${input.epochStartedAt} subscribedAt=${input.subscribedAt}`,
			);
			// Catch up the just-registered connection on frames a publish that beat this
			// register would have missed it on (#714). Replay reaches ONLY this
			// connection, which fan-out could not have — see {@link replayBuffer}.
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
			// Stamp the topic's monotonic ordinal as this frame's `eventId` BEFORE fan-out,
			// so the live-delivered frame, the buffered copy, and every replay all carry the
			// SAME per-topic-monotonic SSE `id:` — the client only ever sees in-order,
			// non-stale frames and its last-frame-wins apply is correct (#731). The topic owns
			// the id (overriding any inbound `frame.eventId`): per-topic monotonicity is the
			// invariant, and in production nothing upstream sets one.
			const seq = yield* nextSeq;
			const frame: DeliverFrame = {...input.frame, eventId: String(seq)};
			const entries = yield* loadRows(input.topicKey);
			// [DIAG2049] stage FRAME-ROUTE — the published frame reached the topic role and
			// its subscriber registry was listed. `subscriberCount` is how many rows this
			// topic will fan the frame out to; 0 = published-into-the-void (no subscriber on
			// the exact key the publish routed to — the register/publish key MUST match).
			console.log(
				`[DIAG2049][FRAME-ROUTE] topicKey=${input.topicKey} seq=${seq} eventId=${frame.eventId} frameKind=${frame.kind} subscriberCount=${entries.length}`,
			);
			// Fan out per-connection deliver passes concurrently (connections are
			// independent). The inner per-row loop stays sequential because it
			// short-circuits on the first unreachable item.
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
							// Any failure/defect/timeout on the cross-role deliver = "couldn't
							// reach" → reap the whole group (void deletes ALL a connection's
							// rows on a 410/404/no response). First failure flips `reachable`.
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
							// [DIAG2049] stage DRAIN — the outcome of enqueueing this frame onto the held
							// connection's SSE queue. delivered=true ⇒ frame reached the subscriber's
							// stream; undefined ⇒ deliver unreachable/timed-out (connection reaped);
							// stale=true ⇒ row stale (generation/revision mismatch), frame dropped.
							console.log(
								`[DIAG2049][DRAIN] topicKey=${input.topicKey} connectionId=${connectionId} subId=${item.row.subId} rowGeneration=${item.row.generation} delivered=${result?.delivered} stale=${result?.stale} unreachable=${result === undefined}`,
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
			// Retain the SAME seq-stamped frame for a subscriber whose register lands after
			// this publish (#714). After fan-out, so the ring reflects what already went out
			// live — buffered `eventId` === the live wire `id:`, so replay resumes exactly.
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
			// The probe budget the last `register` threaded (decision 2B); the shared
			// `defaultLiveLimits` is the fallback when no row has armed the alarm yet —
			// never a DO-invented literal. See {@link REAP_PROBE_TIMEOUT_KEY}.
			const probeTimeout =
				(yield* state.storage.get<number>(REAP_PROBE_TIMEOUT_KEY)) ??
				defaultLiveLimits.deliveryAttemptTimeoutMs;
			const perConnection = yield* Effect.forEach(
				grouped,
				([connectionId, items]) =>
					Effect.gen(function* () {
						// First failed probe → reap ALL that connection's rows (void-faithful:
						// no consecutive-miss counter). A reachable connection reports which
						// of its rows are stale; we reap exactly those.
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
 * The `LiveDO` implementation Layer (ADR 0028). The DO's OWN namespace is
 * resolved once in the outer (per-instance) init for cross-role addressing —
 * void's `this.env[binding]` pattern — via `Cloudflare.DurableObject`, the
 * beta.59 self-namespace yield (ADR 0124, superseding ADR 0037's removed
 * `DurableObjectNamespaceScope`). The requirement is discharged at the yield
 * site (see below), so the Layer stays `Layer<LiveDO, never, Worker>`; the RPC
 * methods themselves are `RuntimeContext`-colored (beta.59) and discharged at
 * the worker call seam / in tests via `RuntimeContext.phantom`.
 */
export const LiveDOLive = LiveDO.make(
	Effect.gen(function* () {
		// Resolve the DO's OWN namespace once (outer, per-instance init — runs on the
		// platform when the DO boots, NOT at stack build), for cross-role addressing.
		// Must be the OUTER init, not a handler: `.make` provides `DurableObjectScope`
		// to the constructor (alchemy DurableObject.js:640), and the bridge runs the
		// constructor per-instance but does NOT thread the scope into the inner
		// handlers, so a handler-level yield would die at runtime. NOT
		// `LiveDO.from(Self)`: it needs the host `Worker`, reintroducing the worker↔DO
		// cycle this scope avoids. The cast discharges the phantom `Req`: `.make<Req>`
		// leaves the self-scope in `Req` (it's not a `DurableObjectServices` member)
		// even though it's provided at runtime, so we narrow the whole Effect to
		// `Effect<LiveNamespace>` (success widened to this DO's namespace, `R` narrowed
		// to `never`), grounded in that runtime provision (ADR 0124). `DurableObjectClass`
		// and `Effect` don't structurally overlap, so a lone `as` won't convert — the
		// double cast is the only spelling, and it's laundering a KNOWN-provided service,
		// not an unverified value.
		// biome-ignore lint/plugin: discharges the self-scope `Req` that `.make` provides at runtime (alchemy DurableObject.js:640) but leaves in the type — the beta.59 typing gap ADR 0124 records; no value is fabricated, the runtime yield is unchanged.
		const live = yield* Cloudflare.DurableObject as unknown as Effect.Effect<LiveNamespace>;
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			const instance = makeLiveInstance(state, live);
			return {
				// The SSE upgrade stays a `fetch` (request-shaped).
				fetch: Effect.gen(function* () {
					const raw = yield* Cloudflare.Request;
					const url = new URL(raw.url);
					// The route threads the per-request queue cap on the URL; fall back to
					// a safe default if the param is missing/unparseable.
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
