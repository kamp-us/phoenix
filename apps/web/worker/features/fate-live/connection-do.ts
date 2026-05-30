/**
 * `ConnectionDO` — the connection-role half of phoenix's live fan-out (ADR 0023,
 * split per ADR 0025), on alchemy's modular Effect Durable Object model (ADR 0028).
 *
 * One instance per client connection, named `connection:<connectionId>`. It owns
 * one client's **open SSE stream** (the `ReadableStream` controller), that
 * connection's **subscription list**, the validated **owner**, and the persisted
 * **`epoch`** (so a reconnect after eviction always lands on a higher
 * epoch than any stale subscriber row a topic DO still holds). The held
 * stream pins this DO in memory (no hibernation), so the controller +
 * subscription map live in the per-instance closure; only `epoch` is
 * persisted.
 *
 * **Modular `.make()` form** — the `ConnectionDO` class is a lightweight Tag
 * (identity + the RPC contract on its 2nd type param, NO inline body), and
 * {@link ConnectionDOLive} is the implementation Layer. Splitting the two retires
 * the old `as never` sibling-cast seam: the sibling `TopicDO` namespace is
 * obtained by `yield*`-ing its Tag (a context lookup alchemy provides on the DO
 * side from the worker's captured services), so no cast is needed. Siblings are
 * addressed by name (`getByName(\`topic:${key}\`)`) — never
 * `idFromName`/`idFromString`/`get` (unavailable on the alchemy stub).
 *
 * The `TopicDO` sibling is resolved **per register/deregister call** (`yield*
 * TopicDO` inside `subscribe`/`unsubscribe`, never in init): resolving it in
 * shared init would pin the sibling Tag onto this Layer's requirements and, paired
 * with the mirror dependency in `TopicDOLive`, form a circular Layer dependency
 * `Layer.mergeAll` can't satisfy. Per-call, the Tag requirement lands on the RPC
 * method's `R` instead (declared in {@link ConnectionRpcSurface}), which alchemy
 * provides from the DO's own captured services at invocation.
 *
 * The SSE upgrade stays a `fetch` (request-shaped): the route forwards `GET
 * /fate/live?connectionId=…&ownerId=…` and this DO returns the held stream as
 * `HttpServerResponse`. Everything else (`subscribe`/`unsubscribe`/`deliver`/
 * `probe`) is typed RPC.
 *
 * The behavior itself — held SSE stream, epoch-based stale detection, the alarm
 * reap's connection side — lives in {@link makeConnectionInstance} below. The
 * builder takes the resolved `Cloudflare.DurableObjectState` plus a resolver for
 * the sibling topic stub, so the same algorithm is unit-testable in the node pool
 * (`do.test.ts`) without workerd. The observable SSE contract is also covered
 * black-box over HTTP in `tests/integration/fate-live.test.ts`.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {ConnectionRpc, SubscribeControl, TopicRpc} from "./protocol.ts";
import {encodeFrame, SSE_HEADERS, topicsForSubscribe} from "./protocol.ts";
import TopicDO from "./topic-do.ts";

/** Storage key for the persisted epoch counter (survives eviction). */
const EPOCH_KEY = "epoch";

/** The state value alchemy hands the per-instance Effect (`yield* DurableObjectState`). */
type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

/**
 * The connection DO's public method surface (typed RPC + the SSE `openStream`).
 * `SR` is the requirement the sibling resolver introduces — in the real DO it is
 * `TopicDO | Worker` (the topic sibling is resolved per call, `Effect.map(TopicDO,
 * …)`, which alchemy provides from the DO's own captured services at invocation);
 * in the node-pool test it is `never` (the test injects in-process stubs). It
 * surfaces only on `subscribe`/`unsubscribe`, the methods that resolve the topic
 * sibling.
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
 * Build the connection-role DO's per-instance methods.
 *
 * `state` is the resolved `Cloudflare.DurableObjectState` for this instance.
 * `resolveTopic` is the sibling resolver — the modular DO passes a thunk that
 * resolves the topic namespace per call (`Effect.map(TopicDO, …)`) and addresses
 * a topic by key, so the cross-DO Tag lands on the RPC method's `R` rather than
 * the Layer's init requirements (non-circular under `.make()`, ADR 0028). The
 * connection's own name is `connection:${connectionId}`; the
 * topic DO addresses it back by that key, so `subscribe` registers under the
 * client-supplied `connectionId`.
 */
export const makeConnectionInstance = <SR = never>(
	state: DurableObjectStateValue,
	resolveTopic: (topicKey: string) => Effect.Effect<TopicRpc, never, SR>,
): ConnectionInstance<SR> => {
	const encoder = new TextEncoder();
	const CONNECTED_FRAME = encoder.encode(": connected\n\n");
	const HEARTBEAT_FRAME = encoder.encode(": heartbeat\n\n");

	// Per-instance, closure-held (was: instance fields on the legacy class). The
	// open SSE stream pins this DO in memory (no hibernation), so the frame queue
	// + subscription list live in memory; only `epoch` is persisted. The queue
	// is the producer side of the merged SSE Stream — `deliver` offers encoded
	// frames onto it; the heartbeat is a sibling Stream merged in at `openStream`.
	let framesQueue: Queue.Queue<Uint8Array> | undefined;
	let ownerId: string | undefined;
	let connectionId: string | undefined;
	let epoch: number | undefined;
	const subscriptions = new Map<string, {topics: ReadonlyArray<string>}>();

	const loadEpoch = Effect.gen(function* () {
		if (epoch === undefined) {
			epoch = (yield* state.storage.get<number>(EPOCH_KEY)) ?? 0;
		}
		return epoch;
	});

	const closeStream = Effect.gen(function* () {
		const q = framesQueue;
		if (q !== undefined) {
			framesQueue = undefined;
			// `Queue.shutdown` is idempotent and completes the Dequeue side, which
			// terminates `Stream.fromQueue`. The merged heartbeat fiber is then torn
			// down by the merged-stream finalizer (no separate interval to clear).
			yield* Queue.shutdown(q);
		}
	});

	const openStream: ConnectionInstance["openStream"] = (input) =>
		Effect.gen(function* () {
			const nextOwner = input.ownerId;
			const nextConnection = input.connectionId;
			// A reconnect on the same connection name bumps the epoch so the topic
			// DOs' rows from the prior stream are detected stale on next deliver. The
			// counter is persisted, so a reconnect after eviction still lands on a
			// higher epoch than any stale row (no collision/cross-talk).
			const next = (yield* loadEpoch) + 1;
			epoch = next;
			yield* state.storage.put(EPOCH_KEY, next);
			ownerId = nextOwner;
			connectionId = nextConnection;
			subscriptions.clear();
			yield* closeStream;

			const queue = yield* Queue.unbounded<Uint8Array>();
			framesQueue = queue;
			// Initial SSE preamble — offered before the stream is wired to the response
			// so the first frame the client reads is `: connected\n\n`, matching the
			// legacy controller's synchronous `enqueue` in `start`.
			yield* Queue.offer(queue, CONNECTED_FRAME);

			// 25-second heartbeat cadence. `Stream.tick` emits `void` immediately and
			// then on every interval; `drop(1)` skips the immediate tick so the first
			// heartbeat lands at +25s, matching the legacy `setInterval(25_000)`.
			const heartbeats = Stream.tick("25 seconds").pipe(
				Stream.drop(1),
				Stream.map(() => HEARTBEAT_FRAME),
			);

			const frames = Stream.fromQueue(queue);

			const merged = Stream.merge(frames, heartbeats).pipe(Stream.ensuring(closeStream));

			return HttpServerResponse.stream(merged, {headers: SSE_HEADERS});
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
			const gen = yield* loadEpoch;
			yield* Effect.forEach(
				topics,
				(topicKey) =>
					Effect.gen(function* () {
						// Lazy sibling resolution happens inside `resolveTopic` (the inline
						// DO does `yield* TopicDO` there) — never in init.
						const topic = yield* resolveTopic(topicKey);
						yield* topic.register({connectionId: id, subId: input.control.subId, epoch: gen});
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
			const current = yield* loadEpoch;
			// Stale: the row was registered by an earlier stream epoch, or this
			// connection has no open stream. Report the current epoch so the topic
			// DO can prune the row.
			const queue = framesQueue;
			if (input.epoch !== current || queue === undefined) {
				return {delivered: false, epoch: current};
			}
			// Only deliver if the subscription is still active on this connection.
			if (!subscriptions.has(input.frame.id)) {
				return {delivered: false, epoch: current};
			}
			// `Queue.offer` is total — it returns `false` if the queue has been shut
			// down (the stream was finalized by client disconnect) rather than
			// throwing, so no try/catch is needed. A `false` return means the frame
			// was dropped; report it as undelivered + emit the current epoch so
			// the topic DO prunes the now-orphaned row on its next probe.
			const accepted = yield* Queue.offer(queue, encoder.encode(encodeFrame(input.frame)));
			if (!accepted) {
				yield* closeStream;
				return {delivered: false, epoch: current};
			}
			return {delivered: true, epoch: current};
		});

	const probe: ConnectionInstance["probe"] = () => Effect.map(loadEpoch, (g) => ({epoch: g}));

	return {openStream, subscribe, unsubscribe, deliver, probe};
};

/**
 * The typed RPC contract a caller (the worker's `LiveConnections` handle, or a
 * sibling `TopicDO`) reaches across the `ConnectionDO` stub. `subscribe`/
 * `unsubscribe` carry `R = TopicDO | Worker` because they resolve the topic
 * sibling per call (`yield* TopicDO`, which also needs the `Worker` binding
 * service) — alchemy provides both from the DO's own captured services + global
 * context at invocation, and the worker (which yields `TopicDO`/`Worker` in init
 * and hosts the DO) satisfies them for its `LiveConnections` calls, so no cast is
 * needed at either seam. `deliver`/`probe` resolve nothing, so they stay
 * `R = never`. (`fetch`, the SSE upgrade, is added to every stub by alchemy and
 * need not be listed.)
 */
export type ConnectionRpcSurface = Pick<
	ConnectionInstance<TopicDO | Cloudflare.Worker>,
	"subscribe" | "unsubscribe" | "deliver" | "probe"
>;

/**
 * `ConnectionDO` Tag — identity plus the {@link ConnectionRpcSurface} contract
 * callers reach across the stub. No inline body: the runtime implementation is
 * {@link ConnectionDOLive}, so importing this Tag pulls in no DO runtime code
 * (the bundler tree-shakes `.make()` out of consumers).
 */
export default class ConnectionDO extends Cloudflare.DurableObjectNamespace<
	ConnectionDO,
	ConnectionRpcSurface
>()("ConnectionDO") {}

/**
 * The `ConnectionDO` implementation Layer. The `TopicDO` sibling is resolved per
 * register/deregister call (never in init — that would form a circular Layer
 * dependency with `TopicDOLive`), addressing a specific topic by name.
 */
export const ConnectionDOLive = ConnectionDO.make(
	Effect.gen(function* () {
		// ── SHARED INIT (once per namespace) ──
		// Do NOT resolve the TopicDO sibling here (a `yield* TopicDO` in init would
		// pin the Tag onto this Layer's requirements → circular Layer dependency
		// with TopicDOLive). It's resolved per call below.
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init and
		// break the two-phase DO model — so the nested Effect is intentional here.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			// ── PER-INSTANCE (once per instance wake) ──
			const state = yield* Cloudflare.DurableObjectState;
			const instance = makeConnectionInstance(
				state,
				(topicKey): Effect.Effect<TopicRpc, never, TopicDO | Cloudflare.Worker> =>
					// Resolve the sibling TopicDO Tag per call (alchemy provides it — plus
					// the `Worker` binding service `yield* TopicDO` needs — on the DO side),
					// then address one topic by its human-readable key. The typed stub's
					// RPC surface matches `TopicRpc` exactly — no cast.
					Effect.map(TopicDO, (topics) => topics.getByName(`topic:${topicKey}`)),
			);
			return {
				// The SSE upgrade is request-shaped, so it stays a `fetch`. Read the
				// connection/owner ids off the inbound request and open the held stream.
				fetch: Effect.gen(function* () {
					const raw = yield* Cloudflare.Request;
					const url = new URL(raw.url);
					return yield* instance.openStream({
						ownerId: url.searchParams.get("ownerId") ?? undefined,
						connectionId: url.searchParams.get("connectionId") ?? undefined,
					});
				}),
				subscribe: instance.subscribe,
				unsubscribe: instance.unsubscribe,
				deliver: instance.deliver,
				probe: instance.probe,
			};
		});
	}),
);
