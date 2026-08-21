/**
 * Shared live wire types + topic helpers for the SSE fan-out (ADR 0023).
 *
 * Must stay import-safe in a plain Node runner (no `cloudflare:workers`) — the fate
 * codegen graph depends on it. Frame shapes mirror fate's native `livePayload` /
 * `liveConnectionPayload` / `sse()` exactly, so the browser's fate SSE client parses
 * them unchanged; phoenix swaps only WHERE frames are produced, not their shape.
 */

import {LivePublisher} from "@kampus/fate-effect";
import {
	FateRequestError,
	liveConnectionTopic,
	liveEntityTopic,
	liveGlobalConnectionTopic,
} from "@nkzw/fate/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {brandedId} from "../../lib/ids.ts";

/**
 * A LiveDO connection id (`connection:<connectionId>`). Branded distinctly from
 * {@link EntityId} so the two can't be transposed at a call site — both are bare
 * strings on the wire. Type-only, so the wire form decodes byte-identically.
 */
export const ConnectionId = brandedId("ConnectionId");
export type ConnectionId = typeof ConnectionId.Type;

/**
 * A fate protocol entity id. fate's `isProtocolId` admits a string OR a number, so the
 * brand goes on the *union* — a branded string would silently discard the number arm.
 */
export const EntityId = Schema.Union([Schema.String, Schema.Number]).pipe(Schema.brand("EntityId"));
export type EntityId = typeof EntityId.Type;

/**
 * The ONE source of every live topic name — the union, the subscribe-side decode
 * schema, and every publish site derive from this object, so publish and subscribe
 * can't miss each other via a stray literal. Add a topic by adding ONE entry here.
 */
export const LiveTopic = {
	/** pano feed (no-args, global). */
	posts: "posts",
	/** pano post → comments (args: `{id: postId}`). */
	postComments: "Post.comments",
	/** sözlük term → definitions (args: `{id: termSlug}`). */
	termDefinitions: "Term.definitions",
	/**
	 * pano viewer's saved posts (per-viewer). Registered only so the saved view's
	 * subscribe DECODES instead of 400ing. Deliberately has NO publish target: this
	 * topic is login-blind and shared, so publishing onto it would leak one viewer's
	 * saved membership to every other subscriber. Live save-state rides the entity
	 * `Post` subscribe (`isSaved`) plus the client's `savedReconcile`.
	 */
	savedPosts: "savedPosts",
} as const;

export type LiveTopicKey = (typeof LiveTopic)[keyof typeof LiveTopic];

/**
 * The package `LivePublisher` surface with `topic`'s procedure narrowed to
 * {@link LiveTopicKey} — the publish-side typo gate. The package takes a plain
 * `string`; narrowing makes a misspelled procedure a compile error instead of a
 * silent dead topic. Parameters are contravariant, so no cast or wrapper is needed.
 */
export type WorkerLivePublisher = Omit<typeof LivePublisher.Service, "topic"> & {
	readonly topic: (
		procedure: LiveTopicKey,
		args?: Parameters<(typeof LivePublisher.Service)["topic"]>[1],
	) => ReturnType<(typeof LivePublisher.Service)["topic"]>;
};

/**
 * The one place the package tag is narrowed to the typo-gated surface. Worker
 * mutations must yield THIS, never `LivePublisher` directly — the package tag also
 * compiles but has no gate.
 */
export const WorkerLivePublisher: Effect.Effect<WorkerLivePublisher, never, LivePublisher> =
	LivePublisher;

/**
 * A fate live entity frame body (matches fate's native `livePayload`).
 *
 * The `invalidate` variant says "read this row again" and carries no data: a
 * viewer-derived field's true new value differs per reader, so the re-read must run on
 * the subscriber's own viewer and a payload here would reintroduce the broadcast it
 * exists to avoid (ADR 0314). fate's entity dispatch cannot answer it until #6661 ships
 * upstream and the `@nkzw/fate` pin moves; publishing one before then is inert, not wrong.
 */
export type EntityFrame =
	| {readonly delete: true; readonly id: string | number}
	| {readonly type: "invalidate"; readonly id: string | number}
	| {readonly data: unknown; readonly select?: ReadonlyArray<string>};

/** A fate live connection frame body (matches fate's native `liveConnectionPayload`). */
export type ConnectionFrame =
	| {
			readonly type:
				| "appendEdge"
				| "appendNode"
				| "insertEdgeAfter"
				| "insertEdgeBefore"
				| "prependEdge"
				| "prependNode";
			readonly nodeType: string;
			readonly edge: {readonly cursor?: string; readonly node: unknown};
			readonly targetCursor?: string;
	  }
	| {readonly type: "deleteEdge"; readonly nodeType: string; readonly id: string | number}
	| {readonly type: "invalidate"};

/**
 * A publish to a topic DO. The mutation side resolves the topic string and the
 * payload, so the topic DO relays with no re-resolution. `procedure` is a plain
 * `string` here (wire data); the typo gate lives at {@link WorkerLivePublisher}.
 */
export type PublishMessage =
	| {
			readonly kind: "entity";
			readonly match: {readonly type: string; readonly entityId: string};
			readonly frame: EntityFrame;
			readonly eventId?: string;
	  }
	| {
			readonly kind: "connection";
			readonly match: {
				readonly procedure: string;
				readonly args?: Record<string, unknown>;
			};
			readonly frame: ConnectionFrame;
			readonly eventId?: string;
	  };

/**
 * A pre-bound per-request topic publish, fired-and-forgotten via the request's
 * `waitUntil`. Reaches the DO through the typed RPC stub, never a string-URL
 * `stub.fetch` (ADR 0028/0029).
 */
export type PublishToTopic = (topicKey: string, message: PublishMessage) => void;

/**
 * A control message a connection DO records as a subscription. `lastEventId` tightens
 * replay on top of the primary `subscribedAt` bound — the topic replays only frames
 * from the subscriber's intent forward (see `live-do.ts` `replayBuffer`).
 */
export type SubscribeControl =
	| {
			readonly kind: "subscribe";
			readonly subId: string;
			readonly type: string;
			readonly entityId: string;
			readonly lastEventId?: string;
	  }
	| {
			readonly kind: "subscribeConnection";
			readonly subId: string;
			readonly procedure: LiveTopicKey;
			readonly args?: Record<string, unknown>;
			readonly lastEventId?: string;
	  };

const OptionalArgs = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));

/** Derived from {@link LiveTopic} so an unknown procedure fails decode instead of registering a dead topic. */
const LiveTopicKeySchema = Schema.Literals(Object.values(LiveTopic));

const SubscribeOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("subscribe"),
	type: Schema.String,
	entityId: EntityId,
	args: OptionalArgs,
	lastEventId: Schema.optional(Schema.String),
	select: Schema.Array(Schema.String),
});

const SubscribeConnectionOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("subscribeConnection"),
	type: Schema.String,
	procedure: LiveTopicKeySchema,
	args: OptionalArgs,
	selectionArgs: OptionalArgs,
	lastEventId: Schema.optional(Schema.String),
	select: Schema.Array(Schema.String),
});

const UnsubscribeOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("unsubscribe"),
});

const LiveControlOperationSchema = Schema.Union([
	SubscribeOp,
	SubscribeConnectionOp,
	UnsubscribeOp,
]);

const LiveControlRequestSchema = Schema.Struct({
	version: Schema.Literal(1),
	connectionId: ConnectionId,
	operations: Schema.Array(LiveControlOperationSchema),
});

export type LiveControlOperation = Schema.Schema.Type<typeof LiveControlOperationSchema>;

export type LiveControlRequest = Schema.Schema.Type<typeof LiveControlRequestSchema>;

/**
 * Decode an untrusted live control body, mirroring fate's `assertLiveControlRequest`:
 * a malformed body fails rather than coercing — a missing `entityId` must be rejected,
 * not turned into a dead empty-string subscription.
 */
export const parseLiveControlRequest = (
	value: unknown,
): Effect.Effect<LiveControlRequest, FateRequestError> =>
	Schema.decodeUnknownEffect(LiveControlRequestSchema)(value).pipe(
		Effect.mapError(() => new FateRequestError("BAD_REQUEST", "Invalid Fate live request.")),
	);

/**
 * The frame a connection DO writes to its held SSE stream. `kind` is the fate SSE
 * event name; `id` is the subscription id the client subscribed under.
 */
export interface DeliverFrame {
	readonly kind: "next" | "connection";
	readonly id: string;
	readonly event: EntityFrame | ConnectionFrame;
	readonly eventId?: string;
}

/**
 * The `DeliverFrame` a resolved publish relays as. The relay is frame-body-blind — the
 * SSE event name follows the publish's `kind` alone, so every `EntityFrame` variant,
 * invalidate included, rides the same `"next"` path with no branch of its own.
 *
 * `id` (the fate subscription id) is left empty: one publish fans out to many
 * subscriptions, each stamped with its own id by the topic instance at delivery.
 */
export function deliverFrameOf(message: PublishMessage): DeliverFrame {
	return {
		kind: message.kind === "entity" ? "next" : "connection",
		id: "",
		event: message.frame,
		...(message.eventId !== undefined ? {eventId: message.eventId} : {}),
	};
}

/** Serialize a fate SSE frame, matching fate's native `sse()` exactly. */
export function encodeFrame(frame: DeliverFrame): string {
	const message = {event: frame.event, id: frame.id, kind: frame.kind};
	const lines: Array<string> = [];
	if (frame.eventId) {
		lines.push(`id: ${frame.eventId}`);
	}
	lines.push(`event: ${frame.kind}`);
	lines.push(`data: ${JSON.stringify(message)}`);
	return `${lines.join("\n")}\n\n`;
}

export const SSE_HEADERS = {
	"cache-control": "no-cache",
	connection: "keep-alive",
	"content-type": "text/event-stream; charset=utf-8",
} as const;

/** The topic keys a publish must reach for a given message. */
export function topicsForPublish(message: PublishMessage): ReadonlyArray<string> {
	if (message.kind === "entity") {
		return [liveEntityTopic(message.match.type, message.match.entityId)];
	}
	// A connection publish reaches EXACTLY ONE topic (fate's `if (args) emit(specific)
	// else emit(global)`): an args publish hits only its args-scoped key, a no-args
	// publish only the global wildcard. The subscribe side fans out to BOTH keys, so
	// publishing to both here would deliver one mutation twice (the SSE
	// double-delivery bug) — publish must not.
	return message.match.args !== undefined
		? [liveConnectionTopic(message.match.procedure, message.match.args)]
		: [liveGlobalConnectionTopic(message.match.procedure)];
}

/** The topic keys a connection subscription registers under. */
export function topicsForSubscribe(control: SubscribeControl): ReadonlyArray<string> {
	if (control.kind === "subscribe") {
		return [liveEntityTopic(control.type, control.entityId)];
	}
	return [
		liveConnectionTopic(control.procedure, control.args),
		liveGlobalConnectionTopic(control.procedure),
	];
}

/**
 * Per-request fan-out budgets, threaded onto the LiveDO's RPC inputs rather than
 * hardcoded in the DO: the worker supplies these on each call, the DO never invents
 * its own.
 */
export interface LiveLimits {
	readonly maxSubscriptionsPerConnection: number;
	readonly maxSubscriptionsPerTopic: number;
	readonly maxQueuedEventsPerConnection: number;
	readonly maxEncodedEventSize: number;
	readonly deliveryAttemptTimeoutMs: number;
	/** Ring-buffer depth for the topic catch-up replay (count bound). */
	readonly maxBufferedFramesPerTopic: number;
	/** Ring-buffer age for the topic catch-up replay (TTL bound, ms). */
	readonly bufferedFrameTtlMs: number;
}

/**
 * The default budgets. Live here beside {@link LiveLimits} so neither route imports
 * config out of a sibling ROUTE module.
 */
export const defaultLiveLimits: LiveLimits = {
	maxSubscriptionsPerConnection: 256,
	maxSubscriptionsPerTopic: 256,
	maxQueuedEventsPerConnection: 100,
	maxEncodedEventSize: 64 * 1024,
	deliveryAttemptTimeoutMs: 1500,
	// The catch-up window closes the publish-vs-register race (#714): a few seconds
	// is the observed register-RPC tail under load (~1.7–2.5s), small N caps storage.
	maxBufferedFramesPerTopic: 32,
	bufferedFrameTtlMs: 10_000,
};

/**
 * A persisted topic-role subscriber row (the value under a `sub:` key). Staleness
 * rides two counters — `generation` (the connection's stream lifetime at register
 * time) and `revision` (the subscription's) — and a mismatch on deliver prunes the
 * row. See `live-do.ts` header.
 */
export interface SubscriberRow {
	readonly topicKey: string;
	readonly connectionId: string;
	readonly subId: string;
	readonly generation: number;
	readonly revision: number;
	readonly updatedAt: number;
}

/**
 * A frame the topic role retains in its ring buffer so a subscriber whose `register`
 * lands AFTER the publish can still catch up (#714). Storage-backed, not in-memory:
 * a topic DO is not pinned by any open stream (only connection DOs are), so it evicts
 * between a publish and a later register — an in-memory buffer would be gone exactly
 * when replay needs it. `seq` is the per-topic publish ordinal (replay order + dedup
 * when frames carry no `eventId`); `at` bounds both the TTL and the `subscribedAt`
 * replay window.
 */
export interface BufferedFrame {
	readonly seq: number;
	readonly eventId: string | undefined;
	readonly at: number;
	readonly frame: DeliverFrame;
}
