/**
 * Shared live wire types + topic helpers for the SSE fan-out (ADR 0023).
 *
 * This module is import-safe in a plain Node runner (no `cloudflare:workers`):
 * the per-request live publisher (`live-publisher.ts`) and the fate codegen
 * graph (`fate/schema.ts → fate/config.ts → event-bus.ts`) depend on it, while
 * only the unified `LiveDO` class (`live-do.ts`) and the worker entry pull in
 * the Workers runtime. Keeping the frame shapes + topic resolution here means
 * the publisher, the DO, and the route all speak one vocabulary.
 *
 * The frame shapes mirror fate's native `livePayload` / `liveConnectionPayload`
 * / `sse()` exactly, so the browser's native fate SSE client parses them
 * unchanged — phoenix only swaps where the frames are produced (the DO, from
 * inline-published data), not their shape.
 */

import {
	FateRequestError,
	liveConnectionTopic,
	liveEntityTopic,
	liveGlobalConnectionTopic,
} from "@nkzw/fate/server";
import {LivePublisher} from "@phoenix/fate-effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The closed set of live connection procedures phoenix publishes to / subscribes
 * on. A connection publish (`live.connection(<procedure>)` on the per-request
 * `LivePublisher` service) and the matching subscribe both key their topic off
 * this string; a typo on either side silently creates a dead topic (publish and
 * subscribe miss each other with no failure). The subscribe side is gated by
 * {@link LiveConnectionProcedureSchema}; the publish side is gated by
 * {@link WorkerLivePublisher}, the worker-level accessor every mutation binds
 * the package's plain-string `LivePublisher` through.
 *
 * Derived from the live root list (`posts`) and the nested-connection mutation
 * sites (`Post.comments`, `Term.definitions`). Add a member here when a resolver
 * publishes to a new connection.
 */
export type LiveConnectionProcedure = "posts" | "Post.comments" | "Term.definitions";

/**
 * The package `LivePublisher` service surface with `connection`'s procedure
 * narrowed to {@link LiveConnectionProcedure} — the publish-side typo gate.
 * The package takes a plain `string` by design (it cannot know phoenix's
 * procedures); a mutation binds its publisher through the accessor below
 * (`const live = yield* WorkerLivePublisher`) so a misspelled procedure is a
 * compile error instead of a silent dead topic. Function parameters are
 * contravariant, so the package's service value is assignable here with no
 * cast and no runtime wrapper. Everything but the narrowed parameter
 * references the package type structurally (`Omit`, `Parameters`,
 * `ReturnType`), so the two surfaces cannot drift.
 */
export type WorkerLivePublisher = Omit<typeof LivePublisher.Service, "connection"> & {
	readonly connection: (
		procedure: LiveConnectionProcedure,
		args?: Parameters<(typeof LivePublisher.Service)["connection"]>[1],
	) => ReturnType<(typeof LivePublisher.Service)["connection"]>;
};

/**
 * The ONE seam where the package tag is narrowed to the typo-gated surface:
 * worker mutations write `const live = yield* WorkerLivePublisher` and never
 * import the package tag directly — the un-narrowed `yield* LivePublisher`
 * also compiles, but silently has no gate, so "import the worker accessor,
 * not the package tag" is the (greppable) convention. Same tag, retyped by
 * plain assignability; TS merges the type and value namespaces.
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
 * relays it to every subscriber's connection DO with no re-resolution.
 *
 * `procedure` is a plain `string` here: the envelope is wire data (the DO and
 * `topicsForPublish` genuinely key off any string), and the publish-side typo
 * gate lives at the CALLER surface — {@link WorkerLivePublisher}, the
 * worker-level narrowing over the package's `LivePublisher` (which takes
 * plain strings by design) that every mutation binds its publisher under. The
 * subscribe side stays closed: {@link SubscribeControl} and the
 * control-request schema still reject unknown procedures, so a dead topic
 * cannot be *registered*.
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
 * A pre-bound per-request topic publish: hand it one resolved topic key + the
 * publish message and it fires the typed `LiveDO.publish` RPC (on the
 * `topic:<key>`-named instance), fired-and-forgotten via the request's
 * `waitUntil`. `live-publisher.ts` builds this from the worker-init-resolved
 * `LiveDO` namespace (`getByName`, typed RPC) and
 * `Cloudflare.WorkerExecutionContext.waitUntil` — so a publish reaches the DO
 * via the typed RPC stub, not an `env`-lookup/`idFromName`/string-URL
 * `stub.fetch` (ADR 0028/0029). Named `PublishToTopic` — NOT `LivePublisher`,
 * which is the package's per-request service tag this function ultimately
 * powers (`@phoenix/fate-effect`).
 */
export type PublishToTopic = (topicKey: string, message: PublishMessage) => void;

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
			readonly procedure: LiveConnectionProcedure;
			readonly args?: Record<string, unknown>;
	  };

/**
 * An optional args bag on a control operation — a JSON object (non-null, not an
 * array), mirroring fate's `isRecord`. `Schema.optional` accepts a missing key
 * or an explicit `undefined`, matching the old `isOptionalRecord` guard.
 */
const OptionalArgs = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));

/**
 * The subscribe-side schema literal for {@link LiveConnectionProcedure}. A
 * control request naming an unknown procedure fails decode (→ `BAD_REQUEST`)
 * rather than registering a dead topic. The literal members are pinned to the
 * union by the `satisfies` below, so adding a `LiveConnectionProcedure` member
 * without listing it here is a compile error.
 */
const LiveConnectionProcedureSchema = Schema.Literals([
	"posts",
	"Post.comments",
	"Term.definitions",
] satisfies ReadonlyArray<LiveConnectionProcedure>);

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
	procedure: LiveConnectionProcedureSchema,
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
	// A connection publish reaches EXACTLY ONE topic, mirroring fate's native
	// `createLiveEventBus().connection().emit` (`server/live.ts`: `if (args)
	// emit(connectionEventName) else emit(globalConnectionEventName)`). An args
	// publish hits only the args-scoped key (filter args kept, pagination stripped
	// by `liveConnectionTopic`) the subscriber registered under; a no-args publish
	// (`live.connection("posts")`) hits only the global wildcard, which every
	// args-variant subscriber also listens on via `topicsForSubscribe`. Publishing
	// to BOTH keys would deliver one mutation twice to a subscriber registered
	// under both topics (the SSE double-delivery bug) — the subscribe side fans out
	// to both keys, the publish side must not.
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

// ---------------------------------------------------------------------------
// Unified LiveDO wire types (KV-backed, void-aligned)
// ---------------------------------------------------------------------------

/**
 * Per-request fan-out budgets, threaded onto the LiveDO's RPC inputs rather than
 * hardcoded in the DO (decision 2B). Mirrors void's `LiveLimits`: a connection
 * caps its own subscriptions and its queued-but-unflushed event backlog, a topic
 * caps how many subscribers it registers, and every fan-out event has a maximum
 * encoded size and a per-attempt delivery timeout. The worker/route supplies
 * these on each call ({@link defaultLiveLimits}); the DO never invents its own.
 */
export interface LiveLimits {
	readonly maxSubscriptionsPerConnection: number;
	readonly maxSubscriptionsPerTopic: number;
	readonly maxQueuedEventsPerConnection: number;
	readonly maxEncodedEventSize: number;
	readonly deliveryAttemptTimeoutMs: number;
}

/**
 * The default per-request fan-out budgets, mirroring void's `DEFAULT_LIMITS`
 * (`void/dist/runtime/live.mjs`). Threaded onto each `LiveDO` subscribe/publish
 * call (decision 2B) rather than hardcoded in the DO, so a future request-scoped
 * override has exactly one seam. Both routes that publish/subscribe consume it
 * (`fate-live/route.ts`, `fate/route.ts`) — it lives HERE, beside the
 * {@link LiveLimits} shape, so neither route imports config out of a sibling
 * ROUTE module. `maxOperationsPerControlRequest` is void's
 * control-request cap, not a `LiveLimits` field — it is not part of the DO
 * budget and so is omitted here.
 */
export const defaultLiveLimits: LiveLimits = {
	maxSubscriptionsPerConnection: 256,
	maxSubscriptionsPerTopic: 256,
	maxQueuedEventsPerConnection: 100,
	maxEncodedEventSize: 64 * 1024,
	deliveryAttemptTimeoutMs: 1500,
};

/**
 * A persisted topic-role subscriber row (the value stored under a `sub:` KV key,
 * void's flat-key model). `connectionId` is the human-readable connection name
 * the topic re-addresses the instance from (`connectionOf`,
 * `live-do.ts`); `subId` is the
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
