/**
 * Shared live wire types + topic helpers for the SSE fan-out (ADR 0023).
 *
 * This module is import-safe in a plain Node runner (no `cloudflare:workers`):
 * the publish-only `liveBus` (`event-bus.ts`) and the fate codegen graph
 * (`fate/schema.ts → fate/server.ts → event-bus.ts`) depend on it, while only the
 * `ConnectionDO` + `TopicDO` classes (`connection-do.ts`, `topic-do.ts`) and the
 * worker entry pull in the Workers runtime. Keeping the frame shapes + topic
 * resolution here means the bus, the DOs, and the route all speak one vocabulary.
 *
 * The frame shapes mirror fate's native `livePayload` / `liveConnectionPayload`
 * / `sse()` exactly, so the browser's native fate SSE client parses them
 * unchanged — phoenix only swaps where the frames are produced (the DO, from
 * inline-published data), not their shape.
 *
 * The shared cross-DO RPC types (`ConnectionRpc`, `TopicRpc`, `DeliverResult`,
 * `ProbeResult`) live here too — both `connection-do.ts` and `topic-do.ts` import
 * them, and pinning them in protocol.ts (instead of in either DO file) keeps the
 * two DOs symmetric and avoids an arbitrary "instance" module both have to import.
 */

import {
	FateRequestError,
	liveConnectionTopic,
	liveEntityTopic,
	liveGlobalConnectionTopic,
} from "@nkzw/fate/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
 * relays it to every subscriber's connection DO with no re-resolution.
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
			readonly match: {readonly procedure: string; readonly args?: Record<string, unknown>};
			readonly frame: ConnectionFrame;
			readonly eventId?: string;
	  };

/** A control message a connection DO records as a subscription. */
export type SubscribeControl =
	| {
			readonly kind: "subscribe";
			readonly subId: string;
			readonly type: string;
			readonly entityId: string;
	  }
	| {
			readonly kind: "subscribeConnection";
			readonly subId: string;
			readonly procedure: string;
			readonly args?: Record<string, unknown>;
	  };

/**
 * An optional args bag on a control operation — a JSON object (non-null, not an
 * array), mirroring fate's `isRecord`. `Schema.optional` accepts a missing key
 * or an explicit `undefined`, matching the old `isOptionalRecord` guard.
 */
const OptionalArgs = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));

/** A `subscribe` (entity) control operation. */
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

/** A `subscribeConnection` (connection) control operation. */
const SubscribeConnectionOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("subscribeConnection"),
	type: Schema.String,
	procedure: Schema.String,
	args: OptionalArgs,
	selectionArgs: OptionalArgs,
	lastEventId: Schema.optional(Schema.String),
	select: Schema.Array(Schema.String),
});

/** An `unsubscribe` control operation — just `id` + `kind`. */
const UnsubscribeOp = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("unsubscribe"),
});

/**
 * A single operation inside a fate live control request — the discriminated
 * union of the three `kind`s. This schema is the single source of truth; the
 * `LiveControlOperation` type is derived from it so validation and type can't
 * drift.
 */
const LiveControlOperationSchema = Schema.Union([
	SubscribeOp,
	SubscribeConnectionOp,
	UnsubscribeOp,
]);

/** The fate live control request body envelope (POST /fate/live). */
const LiveControlRequestSchema = Schema.Struct({
	version: Schema.Literal(1),
	connectionId: Schema.String,
	operations: Schema.Array(LiveControlOperationSchema),
});

/** A single operation inside a fate live control request, post-validation. */
export type LiveControlOperation = Schema.Schema.Type<typeof LiveControlOperationSchema>;

/** A validated fate live control request body (POST /fate/live). */
export type LiveControlRequest = Schema.Schema.Type<typeof LiveControlRequestSchema>;

/**
 * Decode an untrusted fate live control request body, mirroring fate's native
 * `assertLiveControlRequest` exactly (a malformed body fails with a
 * `BAD_REQUEST` `FateRequestError` rather than coercing — e.g. a missing/non-id
 * `entityId` is rejected instead of becoming a dead empty-string subscription).
 * Any `ParseError` collapses to the same `FateRequestError` the route already
 * maps to a `liveError(...)`, so the /fate/live HTTP contract is unchanged.
 */
export const parseLiveControlRequest = (
	value: unknown,
): Effect.Effect<LiveControlRequest, FateRequestError> =>
	Schema.decodeUnknownEffect(LiveControlRequestSchema)(value).pipe(
		Effect.mapError(() => new FateRequestError("BAD_REQUEST", "Invalid Fate live request.")),
	);

/**
 * The frame a connection DO writes to its held SSE stream. `kind` is the fate
 * SSE event name (`next` | `connection`); `event` is the frame body; `id` is the
 * operation/subscription id the client subscribed under.
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
	// A connection publish reaches both the args-scoped topic (filter args kept,
	// pagination stripped by fate's `liveConnectionTopic`) and the global wildcard
	// topic. Threading the publish args yields the SAME args-scoped key the
	// subscriber registered under in `topicsForSubscribe`, so a publish hits the
	// narrow topic directly instead of fanning out to every variant via the global
	// wildcard — `live.connection("posts")` (no args) still reaches every feed-sort
	// variant through the global topic.
	return [
		liveConnectionTopic(message.match.procedure, message.match.args),
		liveGlobalConnectionTopic(message.match.procedure),
	];
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

// ---------------------------------------------------------------------------
// Cross-DO RPC types (shared by connection-do.ts and topic-do.ts)
// ---------------------------------------------------------------------------

/** What a topic DO reports back to the connection it delivered/probed. */
export interface DeliverResult {
	readonly delivered: boolean;
	readonly epoch: number;
}

/** What a connection DO reports for an epoch probe. */
export interface ProbeResult {
	readonly epoch: number;
}

/** The typed RPC surface a `TopicDO` calls on a connection stub. */
export interface ConnectionRpc {
	readonly deliver: (input: {
		readonly frame: DeliverFrame;
		readonly epoch: number;
	}) => Effect.Effect<DeliverResult, never, never>;
	readonly probe: () => Effect.Effect<ProbeResult, never, never>;
}

/** The typed RPC surface a `ConnectionDO` calls on a topic stub. */
export interface TopicRpc {
	readonly register: (row: {
		readonly connectionId: string;
		readonly subId: string;
		readonly epoch: number;
	}) => Effect.Effect<{readonly ok: true}, never, never>;
	readonly deregister: (input: {
		readonly connectionId: string;
		readonly subId: string;
	}) => Effect.Effect<{readonly ok: true}, never, never>;
}

// ---------------------------------------------------------------------------
// Unified LiveDO wire types (KV-backed, void-aligned)
// ---------------------------------------------------------------------------

/**
 * Per-request fan-out budgets, threaded onto the LiveDO's RPC inputs rather than
 * hardcoded in the DO (decision 2B). Mirrors void's `LiveLimits`: a connection
 * caps its own subscriptions and its queued-but-unflushed event backlog, a topic
 * caps how many subscribers it registers, and every fan-out event has a maximum
 * encoded size and a per-attempt delivery timeout. The worker/route supplies
 * these on each call (wired in a later step); the DO never invents its own.
 */
export interface LiveLimits {
	readonly maxSubscriptionsPerConnection: number;
	readonly maxSubscriptionsPerTopic: number;
	readonly maxQueuedEventsPerConnection: number;
	readonly maxEncodedEventSize: number;
	readonly deliveryAttemptTimeoutMs: number;
}

/**
 * A persisted topic-role subscriber row (the value stored under a `sub:` KV key,
 * void's flat-key model). `connectionId` is the human-readable connection name
 * the topic re-derives `connection:${connectionId}` from; `subId` is the
 * client's subscription id. The void-faithful stale model rides two counters:
 * `generation` captures the connection's stream lifetime at register time (a
 * (re)connect bumps the connection's persisted generation), and `revision`
 * captures the subscription's lifetime (a re-subscribe under the same id bumps
 * it). On deliver/check a *reachable* connection compares both against its live
 * state; a mismatch (or a gone/inactive subscription) means the row is stale and
 * the topic prunes it.
 */
export interface SubscriberRow {
	readonly topicKey: string;
	readonly connectionId: string;
	readonly subId: string;
	readonly generation: number;
	readonly revision: number;
	readonly updatedAt: number;
}
