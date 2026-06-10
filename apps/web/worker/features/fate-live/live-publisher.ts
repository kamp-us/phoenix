/**
 * The worker-side live implementation of `@phoenix/fate-effect`'s
 * `LivePublisher` per-request service (PRD story 9; the contract lives in the
 * package — `packages/fate-effect/src/LivePublisher.ts` — and its tag identity
 * is load-bearing, see `.patterns/fate-effect-server.md`).
 *
 * This module is where "a publish cannot fail the mutation" stops being the
 * bridge's per-call-site `useIgnore` convention and becomes the service's
 * type: every publish method is `Effect<void>` (E = `never`), and the two
 * failure modes are handled HERE, once —
 *
 *   - **scheduling**: each publish resolves its topics + frame synchronously
 *     (the same `makeLiveEventBus` code path the bridge publishes through, so
 *     the `PublishMessage` wire shape cannot drift) and hands the topic call
 *     to `waitUntil` as a fire-and-forget promise. Nothing on the request
 *     path awaits the DO fan-out. `waitUntil` is the platform's ONLY way to
 *     extend work past the response on CF (no shutdown hook, no daemon fibers
 *     surviving the request — ADR 0029/0041), so the Effect→Promise
 *     conversion at that sink is the documented boundary, exactly as the
 *     bridge's `/fate` route does it today;
 *   - **swallowing**: a rejecting topic call is caught on the detached
 *     promise and logged (`console.error`, the route's exact behavior); a
 *     synchronous throw (topic resolution, a gone execution context) is
 *     caught by `Effect.try` and ignored-with-log at `Warn` — the
 *     `use`/`useIgnore` law from ADR 0039, now inside the layer instead of at
 *     every call site.
 *
 * No worker-level layer provides this service: the compile step (task 7)
 * provides the value per request — built here from the request's execution
 * context + the worker-init `LiveTopics` publish capability — exactly where
 * the route provides `Auth`/`LiveBus` for the bridge today.
 */
import type {LivePublisher} from "@phoenix/fate-effect";
import * as Effect from "effect/Effect";
import {
	LivePublishError,
	makeLiveEventBus,
	type LivePublisher as PublishToTopic,
} from "./event-bus.ts";
import type {PublishMessage} from "./protocol.ts";

/** The two per-request capabilities the live publisher closes over. */
export interface LivePublisherOptions {
	/**
	 * Deliver one resolved topic publish — in production the worker-init
	 * `LiveTopics.publish` (with the route's per-request `LiveLimits` already
	 * applied), in tests a recording/failing/slow stub. `E = never` by
	 * contract; a misbehaving delivery (defect, rejected promise) is caught on
	 * the detached promise below.
	 */
	readonly publish: (topicKey: string, message: PublishMessage) => Effect.Effect<void>;
	/**
	 * The request's `ExecutionContext.waitUntil` — the only CF mechanism that
	 * keeps the fan-out alive past the response without blocking it.
	 */
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Build the per-request `LivePublisher` service value. Sibling of `liveBusFor`
 * (the bridge's equivalent) until tasks 10–13 retire the bridge.
 */
export function livePublisherFor(options: LivePublisherOptions): typeof LivePublisher.Service {
	// One topic publish = one detached promise on the execution context. The
	// Effect→Promise conversion is deliberate: `waitUntil` is a Promise sink
	// outside the request fiber, and `options.publish` is self-contained
	// (R = never), so `runPromise` needs no surrounding services. The terminal
	// `.catch` is the async half of the swallow-with-log contract.
	const schedule: PublishToTopic = (topicKey, message) => {
		options.waitUntil(
			Effect.runPromise(options.publish(topicKey, message)).catch((error: unknown) => {
				console.error(`live publish to topic:${topicKey} failed`, error);
			}),
		);
	};
	const bus = makeLiveEventBus(schedule);

	// The sync half of the swallow-with-log contract: frame building, topic
	// resolution, and the `waitUntil` call itself run inside `Effect.try`, and
	// `ignore` collapses any failure to the `Effect<void>` the service's types
	// promise — the `use`/`useIgnore` law (ADR 0039) applied once, in the layer.
	const swallow = (publishSync: () => void): Effect.Effect<void> =>
		Effect.try({try: publishSync, catch: (cause) => new LivePublishError({cause})}).pipe(
			Effect.ignore({log: "Warn"}),
		);

	return {
		update: (type, id, opts) => swallow(() => bus.update(type, id, opts)),
		delete: (type, id, opts) => swallow(() => bus.delete(type, id, opts)),
		connection: (procedure, args) => {
			const handle = bus.connection(procedure, args);
			return {
				appendNode: (nodeType, id, opts) => swallow(() => handle.appendNode(nodeType, id, opts)),
				prependNode: (nodeType, id, opts) => swallow(() => handle.prependNode(nodeType, id, opts)),
				deleteEdge: (nodeType, id, opts) => swallow(() => handle.deleteEdge(nodeType, id, opts)),
				invalidate: (opts) => swallow(() => handle.invalidate(opts)),
			};
		},
	};
}
