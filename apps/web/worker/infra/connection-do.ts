/**
 * `ConnectionDO` — the connection-role half of phoenix's live fan-out (ADR 0023,
 * split per ADR 0025), on alchemy's modular Effect Durable Object model (ADR 0028).
 *
 * One instance per client connection, named `connection:<connectionId>`. It owns
 * one client's **open SSE stream** (the `ReadableStream` controller), that
 * connection's **subscription list**, the validated **owner**, and the persisted
 * **`generation`** (so a reconnect after eviction always lands on a higher
 * generation than any stale subscriber row a topic DO still holds). The held
 * stream pins this DO in memory (no hibernation), so the controller +
 * subscription map live in the per-instance closure; only `generation` is
 * persisted. The behavior lives in `makeConnectionInstance` (`live-instance.ts`).
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
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {type ConnectionInstance, makeConnectionInstance, type TopicRpc} from "./live-instance.ts";
import TopicDO from "./topic-do.ts";

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
