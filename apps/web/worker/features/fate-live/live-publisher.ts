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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * fate's `livePayload` update frame, narrowed to the keys the mutation changed (#6585).
 *
 * Trimming `data` is the leak fix, not an optimisation: fate's `writeEntity` copies every
 * scalar key PRESENT ON the payload over each subscriber's cached record, gated by
 * `hasOwnProperty` and never by `select` — so an untrimmed node, re-resolved against the
 * MUTATOR's viewer, overwrites everyone else's `myVote`/`isSaved` until they refetch.
 *
 * `select` must then name exactly the keys the trimmed payload carries: the client reads
 * it ahead of the payload and refetches the record whenever the payload cannot cover the
 * selection (`canUseLivePayloadData`), so a `changed` key the node omits would cost every
 * subscriber a round trip. `id` joins the selection because fate's own `changed`→select
 * derivation adds it and `writeEntity` resolves the cache key through it.
 *
 * No `changed` leaves the old whole-node frame standing — an unnarrowed publish stays as
 * loud as it was, rather than silently becoming a no-op.
 */
const updateFrame = (options?: {
	readonly changed?: ReadonlyArray<string>;
	readonly data?: unknown;
}): EntityFrame => {
	const changed = options?.changed?.filter((key) => key.length > 0);
	const data = options?.data;
	if (!changed || changed.length === 0) return {data};
	const select = [...new Set(["id", ...changed])];
	if (!isRecord(data)) return {data, select};
	// A payload with no cache key cannot be merged, so it is dropped rather than trimmed:
	// the subscriber refetches the narrowed `select` instead of receiving a keyless record.
	if (!("id" in data)) return {data: undefined, select};
	const trimmed: Record<string, unknown> = {};
	for (const key of select) {
		if (key in data) trimmed[key] = data[key];
	}
	return {data: trimmed, select: Object.keys(trimmed)};
};

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
					frame: updateFrame(opts),
					...(opts?.eventId !== undefined ? {eventId: opts.eventId} : {}),
				}),
			),
		delete: (type, id, opts) =>
			swallow(() =>
				publish({
					kind: "entity",
					match: {type, entityId: String(id)},
					frame: {delete: true, id},
					...(opts?.eventId !== undefined ? {eventId: opts.eventId} : {}),
				}),
			),
		invalidate: (type, id, opts) =>
			swallow(() =>
				publish({
					kind: "entity",
					match: {type, entityId: String(id)},
					frame: {type: "invalidate", id},
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
