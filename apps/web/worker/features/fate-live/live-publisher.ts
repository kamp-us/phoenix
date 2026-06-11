/**
 * The worker-side live implementation of `@phoenix/fate-effect`'s
 * `LivePublisher` per-request service (the contract lives in the
 * package — `packages/fate-effect/src/LivePublisher.ts` — and its tag identity
 * is load-bearing, see `.patterns/fate-effect-server.md`).
 *
 * This module is THE frame-building code path: each of the service's six
 * publish methods (`update`, `delete`, `connection().appendNode`/
 * `prependNode`/`deleteEdge`/`invalidate`) resolves its `PublishMessage`
 * frame + topic keys right here (frame shapes and `topicsForPublish` come
 * from `protocol.ts`), byte-identical to the retired bridge event-bus —
 * pinned by `live-publisher.unit.test.ts`'s literal + frozen-baseline
 * fixtures. The bus fate's config holds (`event-bus.ts`) is a throwing stub
 * that exists only for the build-time `"subscribe" in live` check.
 *
 * This is also where "a publish cannot fail the mutation" is the service's
 * type, not a per-call-site convention: every publish method is
 * `Effect<void>` (E = `never`), and the two failure modes are handled HERE,
 * once —
 *
 *   - **scheduling**: each publish resolves its topics + frame synchronously
 *     and hands the topic call to `waitUntil` as a fire-and-forget promise.
 *     Nothing on the request path awaits the DO fan-out. `waitUntil` is the
 *     platform's ONLY way to extend work past the response on CF (no shutdown
 *     hook, no daemon fibers surviving the request — ADR 0029/0041), so the
 *     Effect→Promise conversion at that sink is the documented boundary.
 *     One known asymmetry: the detached `Effect.runPromise` starts a FRESH
 *     fiber with no ambient tracer context, so publish spans do not nest
 *     under the request span (they surface as roots). Accepted — the
 *     fan-out is fire-and-forget by design; if span lineage ever matters,
 *     capture the request context at the boundary with `runForkWith`-style
 *     wiring instead of bare `runPromise`;
 *   - **swallowing**: a rejecting topic call is caught on the detached
 *     promise and logged (`console.error`); a synchronous throw (topic
 *     resolution, a gone execution context) is caught by `Effect.try` and
 *     ignored-with-log at `Warn` — the `use`/`useIgnore` law from ADR 0039,
 *     inside the layer instead of at every call site.
 *
 * No worker-level layer provides this service: the `/fate` route builds the
 * value per request — from the request's execution context + the worker-init
 * `LiveTopics` publish capability — and hands it to the interpreter on
 * the request context, exactly where it hands `currentUser`.
 */
import type {LivePublisher} from "@phoenix/fate-effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
	type ConnectionFrame,
	type EntityFrame,
	type PublishMessage,
	type PublishToTopic,
	topicsForPublish,
} from "./protocol.ts";

/**
 * A publish failed inside the swallow wrapper below. It never reaches the
 * fate boundary: a mutation publishes *after* its DB write, so the publish
 * must not be able to fail the committed mutation — the publisher maps this
 * away (logged at `Warn`) in its `never` error channel (ADR 0039's
 * use/useIgnore law, applied once inside the layer).
 */
export class LivePublishError extends Schema.TaggedErrorClass<LivePublishError>()(
	"fate-live/LivePublishError",
	{
		cause: Schema.Defect(),
	},
) {}

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

/** Build the fate entity frame for an update/delete publish (fate's `livePayload` shape). */
const entityFrame = (
	type: "update" | "delete",
	id: string | number,
	options?: {readonly data?: unknown},
): EntityFrame => (type === "delete" ? {delete: true, id} : {data: options?.data});

/** Build the connection edge frame for an appendNode/prependNode publish. */
const nodeFrame = (
	type: "appendNode" | "prependNode",
	nodeType: string,
	options?: {readonly node?: unknown; readonly cursor?: string},
): ConnectionFrame => ({
	type,
	nodeType,
	edge: {node: options?.node, ...(options?.cursor ? {cursor: options.cursor} : {})},
});

/** Build the per-request `LivePublisher` service value. */
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

	// Resolve the message's topic keys and schedule one delivery per key.
	const publish = (message: PublishMessage): void => {
		for (const topicKey of topicsForPublish(message)) {
			schedule(topicKey, message);
		}
	};

	// The sync half of the swallow-with-log contract: frame building, topic
	// resolution, and the `waitUntil` call itself run inside `Effect.try`, and
	// `ignore` collapses any failure to the `Effect<void>` the service's types
	// promise — the `use`/`useIgnore` law (ADR 0039) applied once, in the layer.
	const swallow = (publishSync: () => void): Effect.Effect<void> =>
		Effect.try({try: publishSync, catch: (cause) => new LivePublishError({cause})}).pipe(
			Effect.ignore({log: "Warn"}),
		);

	return {
		update: (type, id, opts) =>
			swallow(() =>
				publish({
					kind: "entity",
					match: {type, entityId: String(id)},
					frame: entityFrame("update", id, opts),
					...(opts?.eventId !== undefined ? {eventId: opts.eventId} : {}),
				}),
			),
		delete: (type, id, opts) =>
			swallow(() =>
				publish({
					kind: "entity",
					match: {type, entityId: String(id)},
					frame: entityFrame("delete", id),
					...(opts?.eventId !== undefined ? {eventId: opts.eventId} : {}),
				}),
			),
		connection: (procedure, args) => {
			// Carry the connection's filter args into the publish match so
			// `topicsForPublish` resolves the SAME args-scoped `liveConnectionTopic`
			// key the subscriber registered under — the publish hits the narrow topic
			// directly instead of falling back to the procedure-wide global wildcard
			// (which would fan one term's new definition out to every `Term.definitions`
			// subscriber across all slugs/tabs/sessions).
			const match = {procedure, ...(args !== undefined ? {args} : {})};
			const emit = (frame: ConnectionFrame, eventId?: string) =>
				publish({
					kind: "connection",
					match,
					frame,
					...(eventId !== undefined ? {eventId} : {}),
				});
			return {
				appendNode: (nodeType, _id, opts) =>
					swallow(() => emit(nodeFrame("appendNode", nodeType, opts), opts?.eventId)),
				prependNode: (nodeType, _id, opts) =>
					swallow(() => emit(nodeFrame("prependNode", nodeType, opts), opts?.eventId)),
				deleteEdge: (nodeType, id, opts) =>
					swallow(() => emit({type: "deleteEdge", nodeType, id}, opts?.eventId)),
				invalidate: (opts) => swallow(() => emit({type: "invalidate"}, opts?.eventId)),
			};
		},
	};
}
