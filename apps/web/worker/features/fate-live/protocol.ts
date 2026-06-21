/**
 * Shared live wire types + topic helpers for the SSE fan-out (ADR 0023).
 *
 * Import-safe in a plain Node runner (no `cloudflare:workers`): the per-request
 * publisher and the fate codegen graph depend on it, while only `live-do.ts` and
 * the worker entry pull in the Workers runtime. The frame shapes mirror fate's
 * native `livePayload` / `liveConnectionPayload` / `sse()` exactly, so the
 * browser's native fate SSE client parses them unchanged — phoenix only swaps
 * WHERE the frames are produced (the DO), not their shape.
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

/**
 * The ONE source of every live connection-procedure topic name: the string is
 * authored here once, and the union, the subscribe-side decode schema, and every
 * publish call site all derive from / reference this object. A topic key can no
 * longer be mistyped at a call site (publish and subscribe can't miss each other
 * via a stray literal). Add a connection by adding ONE entry here — the union and
 * the schema literal pick it up automatically, and publish sites reference
 * `LiveConnection.<name>` instead of restating the string.
 */
export const LiveConnection = {
	/** pano feed (no-args, global). */
	posts: "posts",
	/** pano post → comments (args: `{id: postId}`). */
	postComments: "Post.comments",
	/** sözlük term → definitions (args: `{id: termSlug}`). */
	termDefinitions: "Term.definitions",
} as const;

/**
 * The closed set of live connection procedures phoenix publishes to / subscribes
 * on, derived from {@link LiveConnection}'s values. The subscribe side is gated by
 * {@link LiveConnectionProcedureSchema}; the publish side by
 * {@link WorkerLivePublisher}.
 */
export type LiveConnectionProcedure = (typeof LiveConnection)[keyof typeof LiveConnection];

/**
 * The package `LivePublisher` service surface with `connection`'s procedure
 * narrowed to {@link LiveConnectionProcedure} — the publish-side typo gate. The
 * package takes a plain `string` by design; narrowing it here makes a misspelled
 * procedure a compile error instead of a silent dead topic. Parameters are
 * contravariant, so the package value is assignable with no cast/wrapper, and
 * everything but the narrowed parameter is structural (`Omit`/`Parameters`/
 * `ReturnType`) so the two surfaces can't drift.
 */
export type WorkerLivePublisher = Omit<typeof LivePublisher.Service, "connection"> & {
	readonly connection: (
		procedure: LiveConnectionProcedure,
		args?: Parameters<(typeof LivePublisher.Service)["connection"]>[1],
	) => ReturnType<(typeof LivePublisher.Service)["connection"]>;
};

/**
 * The ONE seam where the package tag is narrowed to the typo-gated surface:
 * worker mutations write `const live = yield* WorkerLivePublisher` and never the
 * package tag directly. The un-narrowed `yield* LivePublisher` also compiles but
 * has no gate, so "import the worker accessor, not the package tag" is the
 * greppable convention. Same tag, retyped by plain assignability.
 */
export const WorkerLivePublisher: Effect.Effect<WorkerLivePublisher, never, LivePublisher> =
	LivePublisher;

/** A fate live entity frame body (matches fate's native `livePayload`). */
export type EntityFrame =
	| {readonly delete: true; readonly id: string | number}
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
 * per-event payload (already inline-resolved `data`/`node`), so the topic DO
 * relays it with no re-resolution. `procedure` is a plain `string` here (wire
 * data); the publish-side typo gate lives at the caller, {@link WorkerLivePublisher}.
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
 * A pre-bound per-request topic publish: one resolved topic key + message fires
 * the typed `LiveDO.publish` RPC, fired-and-forgotten via the request's
 * `waitUntil`. Reaches the DO via the typed RPC stub, not an
 * `env`-lookup/`idFromName`/string-URL `stub.fetch` (ADR 0028/0029).
 */
export type PublishToTopic = (topicKey: string, message: PublishMessage) => void;

/**
 * A control message a connection DO records as a subscription. `lastEventId` is
 * the last SSE `id:` the client saw on this subscription before this (re)subscribe
 * — threaded through to `register` as an extra tightening on top of the primary
 * `subscribedAt` replay bound (the topic replays only frames from the subscriber's
 * intent forward, never the topic's prior history; see `live-do.ts` `replayBuffer`).
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
			readonly procedure: LiveConnectionProcedure;
			readonly args?: Record<string, unknown>;
			readonly lastEventId?: string;
	  };

const OptionalArgs = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));

/**
 * The subscribe-side schema for {@link LiveConnectionProcedure}, derived from
 * {@link LiveConnection}'s values so it can't drift from the union. An unknown
 * procedure fails decode (→ `BAD_REQUEST`) rather than registering a dead topic.
 */
const LiveConnectionProcedureSchema = Schema.Literals(Object.values(LiveConnection));

const SubscribeOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("subscribe"),
	type: Schema.String,
	// fate's `isProtocolId`: a string or number entity id.
	entityId: Schema.Union([Schema.String, Schema.Number]),
	args: OptionalArgs,
	lastEventId: Schema.optional(Schema.String),
	select: Schema.Array(Schema.String),
});

const SubscribeConnectionOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("subscribeConnection"),
	type: Schema.String,
	procedure: LiveConnectionProcedureSchema,
	args: OptionalArgs,
	selectionArgs: OptionalArgs,
	lastEventId: Schema.optional(Schema.String),
	select: Schema.Array(Schema.String),
});

const UnsubscribeOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("unsubscribe"),
});

/** The schema is the single source of truth; the types below derive from it. */
const LiveControlOperationSchema = Schema.Union([
	SubscribeOp,
	SubscribeConnectionOp,
	UnsubscribeOp,
]);

const LiveControlRequestSchema = Schema.Struct({
	version: Schema.Literal(1),
	connectionId: Schema.String,
	operations: Schema.Array(LiveControlOperationSchema),
});

export type LiveControlOperation = Schema.Schema.Type<typeof LiveControlOperationSchema>;

export type LiveControlRequest = Schema.Schema.Type<typeof LiveControlRequestSchema>;

/**
 * Decode an untrusted fate live control request body, mirroring fate's native
 * `assertLiveControlRequest` (a malformed body fails with a `BAD_REQUEST`
 * `FateRequestError` rather than coercing — e.g. a missing/non-id `entityId` is
 * rejected, not turned into a dead empty-string subscription). Any `ParseError`
 * collapses to the same `FateRequestError` the route maps to `liveError(...)`.
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
 * Per-request fan-out budgets (void's `LiveLimits`), threaded onto the LiveDO's
 * RPC inputs rather than hardcoded in the DO (decision 2B): the worker/route
 * supplies these on each call, the DO never invents its own.
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
 * The default per-request fan-out budgets (void's `DEFAULT_LIMITS`). Lives HERE,
 * beside {@link LiveLimits}, so neither publishing/subscribing route imports
 * config out of a sibling ROUTE module. void's `maxOperationsPerControlRequest`
 * is a control-request cap, not a `LiveLimits` DO budget field, so it is omitted.
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
 * A persisted topic-role subscriber row (the value under a `sub:` KV key, void's
 * flat-key model). `connectionId` is the name the topic re-addresses the instance
 * from (`connectionOf`); `subId` is the client's subscription id. The stale model
 * rides two counters: `generation` (the connection's stream lifetime at register
 * time) and `revision` (the subscription's lifetime). On deliver/check a reachable
 * connection compares both against live state; a mismatch means the topic prunes
 * the row. (See `live-do.ts` header.)
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
 * A frame the topic role retains in its storage-backed ring buffer (under a
 * `frame:<topicKey>:<seq>` key) so a subscriber whose `register` lands AFTER the
 * publish can still catch up — the publish-vs-register race fix (#714). The buffer
 * is storage-backed, not in-memory: a topic DO is not pinned by any open stream
 * (only connection DOs are), so it evicts between a publish and a later register,
 * and an in-memory buffer would be gone exactly when replay needs it. `seq` is the
 * monotonic per-topic publish ordinal (replay order, and dedup when frames carry no
 * `eventId`); `eventId` is the optional wire id that tightens replay by the
 * subscriber's `lastEventId`; `at` is the publish timestamp — both the TTL bound
 * and the primary `subscribedAt` replay bound (only frames at/after the
 * subscriber's intent replay; see `live-do.ts` `replayBuffer`).
 */
export interface BufferedFrame {
	readonly seq: number;
	readonly eventId: string | undefined;
	readonly at: number;
	readonly frame: DeliverFrame;
}
