/**
 * The worker-side live implementation of `@phoenix/fate-effect`'s `LivePublisher`
 * per-request service (its tag identity is load-bearing, see
 * `.patterns/fate-effect-server.md`).
 *
 * THE frame-building code path: each publish method resolves its `PublishMessage`
 * frame + topic keys here, byte-identical to the retired bridge event-bus (pinned
 * by `live-publisher.unit.test.ts`'s fixtures).
 *
 * "A publish cannot fail the mutation" is the service's TYPE (every method is
 * `Effect<void>`), with both failure modes handled here, once: scheduling hands
 * the topic call to `waitUntil` as fire-and-forget (CF's ONLY way to extend work
 * past the response — no shutdown hook, ADR 0029/0041), and swallowing catches a
 * rejection on the detached promise / a sync throw via `Effect.try`, logged at
 * `Warn` (ADR 0039's use/useIgnore law, inside the layer not at every call site).
 *
 * Known asymmetry: the detached `Effect.runPromise` starts a FRESH fiber with no
 * ambient tracer context, so publish spans surface as roots, not nested under the
 * request span. Accepted — the fan-out is fire-and-forget by design.
 *
 * No worker-level layer provides this service: the `/fate` route builds the value
 * per request (from the execution context + the worker-init `LiveTopics`) and
 * hands it to the interpreter, where it hands `currentUser`.
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
 * A publish failed inside the swallow wrapper below. Never reaches the fate
 * boundary: the publisher maps it away (logged at `Warn`) in its `never` error
 * channel, since a publish runs after the DB write and must not fail the
 * committed mutation (ADR 0039).
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
	 * `LiveTopics.publish`, in tests a recording/failing/slow stub. `E = never` by
	 * contract; a misbehaving delivery is caught on the detached promise below.
	 */
	readonly publish: (topicKey: string, message: PublishMessage) => Effect.Effect<void>;
	/** The request's `ExecutionContext.waitUntil`. */
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
	// One topic publish = one detached promise; the terminal `.catch` is the async
	// half of the swallow-with-log contract.
	const schedule: PublishToTopic = (topicKey, message) => {
		options.waitUntil(
			Effect.runPromise(options.publish(topicKey, message)).catch((error: unknown) => {
				console.error(`live publish to topic:${topicKey} failed`, error);
			}),
		);
	};

	const publish = (message: PublishMessage): void => {
		for (const topicKey of topicsForPublish(message)) {
			schedule(topicKey, message);
		}
	};

	// Sync half of the swallow-with-log contract: frame building + the `waitUntil`
	// call run inside `Effect.try`, and `ignore` collapses any failure to the
	// `Effect<void>` the service's types promise (ADR 0039, once in the layer).
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
			// Carry the connection's filter args into the match so `topicsForPublish`
			// resolves the SAME args-scoped key the subscriber registered under, instead
			// of the procedure-wide global wildcard (which would fan one term's new
			// definition out to every `Term.definitions` subscriber across all slugs).
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
