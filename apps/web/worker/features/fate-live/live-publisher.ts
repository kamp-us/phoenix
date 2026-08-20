/**
 * The worker-side implementation of `@kampus/fate-effect`'s `LivePublisher`
 * per-request service — its tag identity is load-bearing, see
 * `.patterns/fate-effect-server.md`.
 *
 * "A publish cannot fail the mutation" is the service's TYPE (every method returns
 * `Effect<void>`), and both failure modes are handled here once: `waitUntil` is CF's
 * only way to extend work past the response (no shutdown hook, ADR 0029/0041), and
 * the swallow wrappers log at `Warn` per ADR 0039 rather than at every call site.
 *
 * Known asymmetry: the detached `Effect.runPromise` starts a FRESH fiber with no
 * ambient tracer context, so publish spans surface as roots. Accepted.
 *
 * No worker-level layer provides this: the `/fate` route builds the value per request.
 */
import type {LivePublisher} from "@kampus/fate-effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {LiveTransportError} from "./cold-start-retry.ts";
import {
	type ConnectionFrame,
	type EntityFrame,
	type PublishMessage,
	type PublishToTopic,
	topicsForPublish,
} from "./protocol.ts";

/**
 * A publish failed inside the swallow wrapper below. Never reaches the fate boundary:
 * a publish runs after the DB write and must not fail the committed mutation (ADR 0039).
 */
export class LivePublishError extends Schema.TaggedErrorClass<LivePublishError>()(
	"fate-live/LivePublishError",
	{
		cause: Schema.Defect(),
	},
) {}

export interface LivePublisherOptions {
	/**
	 * Deliver one resolved topic publish. Its only failure is `LiveTransportError` (a
	 * cold-start-retry-exhausted publish), swallowed-and-logged on the detached promise
	 * below so it never reaches the committed mutation.
	 */
	readonly publish: (
		topicKey: string,
		message: PublishMessage,
	) => Effect.Effect<void, LiveTransportError>;
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** fate's `livePayload` shape. */
const entityFrame = (
	type: "update" | "delete",
	id: string | number,
	options?: {readonly data?: unknown},
): EntityFrame => (type === "delete" ? {delete: true, id} : {data: options?.data});

const nodeFrame = (
	type: "appendNode" | "prependNode",
	nodeType: string,
	options?: {readonly node?: unknown; readonly cursor?: string},
): ConnectionFrame => ({
	type,
	nodeType,
	edge: {node: options?.node, ...(options?.cursor ? {cursor: options.cursor} : {})},
});

export function livePublisherFor(options: LivePublisherOptions): typeof LivePublisher.Service {
	// Async half of the swallow-with-log contract. Logging through the Effect logger
	// (not `console.error`) is what gets an exhausted publish into Sentry breadcrumbs (#2551).
	const schedule: PublishToTopic = (topicKey, message) => {
		options.waitUntil(
			Effect.runPromise(
				options
					.publish(topicKey, message)
					.pipe(
						Effect.ignoreCause({log: "Warn", message: `live publish to topic:${topicKey} failed`}),
					),
			),
		);
	};

	const publish = (message: PublishMessage): void => {
		for (const topicKey of topicsForPublish(message)) {
			schedule(topicKey, message);
		}
	};

	// Sync half: frame building + the `waitUntil` call collapse to the `Effect<void>`
	// the service's types promise (ADR 0039).
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
		topic: (procedure, args) => {
			// The args must ride into the match so `topicsForPublish` resolves the SAME
			// args-scoped key the subscriber registered under; the global wildcard would fan
			// one term's new definition out to every `Term.definitions` subscriber.
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
