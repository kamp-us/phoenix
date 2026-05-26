/**
 * `ConnectionDO` — the connection-role half of phoenix's live fan-out (ADR 0023,
 * split per ADR 0025), on alchemy's Effect Durable Object model (ADR 0028).
 *
 * One instance per client connection, named `connection:<connectionId>`. It owns
 * one client's **open SSE stream** (the `ReadableStream` controller), that
 * connection's **subscription list**, the validated **owner**, and the persisted
 * **`generation`** (so a reconnect after eviction always lands on a higher
 * generation than any stale subscriber row a topic DO still holds). The held
 * stream pins this DO in memory (no hibernation), so the controller +
 * subscription map live in the per-instance closure; only `generation` is
 * persisted. The behavior lives in `makeConnectionInstance` (`live-instance.ts`);
 * this file is the inline-form `DurableObjectNamespace` declaration.
 *
 * **Inline form is mandatory** — the modular `.make()` form is unimplemented for
 * DOs in alchemy@2.0.0-beta.44 (ADR 0028). The `TopicDO` sibling is resolved
 * **lazily inside `subscribe`/`unsubscribe`** (`yield* TopicDO` per call) and
 * addressed by name (`getByName(\`topic:${key}\`)`) — never `yield* TopicDO` in
 * the init block (an eager circular `yield*` OOMs the build) and never
 * `idFromName`/`idFromString`/`get` (unavailable on the alchemy stub).
 *
 * The SSE upgrade stays a `fetch` (request-shaped): the route forwards `GET
 * /fate/live?connectionId=…&ownerId=…` and this DO returns the held stream as
 * `HttpServerResponse`. Everything else (`subscribe`/`unsubscribe`/`deliver`/
 * `probe`) is typed RPC.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {makeConnectionInstance, type TopicRpc} from "./live-instance.ts";
import {type SiblingNamespace, siblingNamespace} from "./resources.ts";
import TopicDO from "./topic-do.ts";

/**
 * Lazily-read view of the `TopicDO` sibling namespace — only its
 * `getByName(...).register/deregister` typed RPC is needed here. The forced
 * `as never` namespace-cast seam (and the reason it must be deferred to call
 * time) lives once in {@link siblingNamespace}, with its revisit TODO.
 */
const topicNamespace: () => SiblingNamespace<TopicRpc> = siblingNamespace<TopicRpc>(() => TopicDO);

export default class ConnectionDO extends Cloudflare.DurableObjectNamespace<ConnectionDO>()(
	"ConnectionDO",
	Effect.gen(function* () {
		// ── SHARED INIT (once per namespace) ──
		// Do NOT resolve the TopicDO sibling here (eager circular `yield*` OOMs the
		// build; ADR 0028). It's resolved lazily, per call, inside subscribe/
		// unsubscribe (below).
		// The shared-init gen RETURNS the per-instance Effect (run once per instance
		// wake). `return yield*` would run per-instance setup during shared init and
		// break the two-phase DO model — so the nested Effect is intentional here.
		// @effect-diagnostics-next-line effect/returnEffectInGen:off
		return Effect.gen(function* () {
			// ── PER-INSTANCE (once per instance wake) ──
			const state = yield* Cloudflare.DurableObjectState;
			const instance = makeConnectionInstance(state, (topicKey) =>
				// Lazy sibling resolution: `yield* TopicDO` happens here, per register/
				// deregister call, never in init. Addressed by the human-readable key.
				Effect.gen(function* () {
					const topics = yield* topicNamespace();
					return topics.getByName(`topic:${topicKey}`);
				}),
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
) {}
