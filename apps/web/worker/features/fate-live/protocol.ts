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
	isRecord,
	liveConnectionTopic,
	liveEntityTopic,
	liveGlobalConnectionTopic,
} from "@nkzw/fate/server";
import type * as Effect from "effect/Effect";

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

/** A single operation inside a fate live control request, post-validation. */
export type LiveControlOperation =
	| {
			readonly id: string;
			readonly kind: "subscribe";
			readonly type: string;
			readonly entityId: string | number;
			readonly args?: Record<string, unknown>;
			readonly lastEventId?: string;
			readonly select: ReadonlyArray<string>;
	  }
	| {
			readonly id: string;
			readonly kind: "subscribeConnection";
			readonly type: string;
			readonly procedure: string;
			readonly args?: Record<string, unknown>;
			readonly selectionArgs?: Record<string, unknown>;
			readonly lastEventId?: string;
			readonly select: ReadonlyArray<string>;
	  }
	| {readonly id: string; readonly kind: "unsubscribe"};

/** A validated fate live control request body (POST /fate/live). */
export interface LiveControlRequest {
	readonly version: 1;
	readonly connectionId: string;
	readonly operations: ReadonlyArray<LiveControlOperation>;
}

const isProtocolId = (value: unknown): value is string | number =>
	typeof value === "string" || typeof value === "number";

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isOptionalRecord = (value: unknown): boolean => value === undefined || isRecord(value);

const isOptionalString = (value: unknown): boolean =>
	value === undefined || typeof value === "string";

/**
 * Validate a fate live control request body, mirroring fate's native
 * `assertLiveControlRequest` exactly (a malformed body throws a `BAD_REQUEST`
 * `FateRequestError` rather than coercing — e.g. a missing/non-id `entityId`
 * is rejected instead of becoming a dead empty-string subscription).
 */
export function assertLiveControlRequest(value: unknown): LiveControlRequest {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.connectionId !== "string" ||
		!Array.isArray(value.operations)
	) {
		throw new FateRequestError("BAD_REQUEST", "Invalid Fate live request.");
	}
	for (const operation of value.operations) {
		if (
			!isRecord(operation) ||
			typeof operation.id !== "string" ||
			typeof operation.kind !== "string"
		) {
			throw new FateRequestError("BAD_REQUEST", "Invalid Fate live operation.");
		}
		if (operation.kind === "subscribe") {
			if (
				typeof operation.type !== "string" ||
				!isProtocolId(operation.entityId) ||
				!isOptionalRecord(operation.args) ||
				!isOptionalString(operation.lastEventId) ||
				!isStringArray(operation.select)
			) {
				throw new FateRequestError("BAD_REQUEST", "Invalid Fate live subscribe operation.");
			}
			continue;
		}
		if (operation.kind === "subscribeConnection") {
			if (
				typeof operation.type !== "string" ||
				typeof operation.procedure !== "string" ||
				!isOptionalRecord(operation.args) ||
				!isOptionalRecord(operation.selectionArgs) ||
				!isOptionalString(operation.lastEventId) ||
				!isStringArray(operation.select)
			) {
				throw new FateRequestError(
					"BAD_REQUEST",
					"Invalid Fate live connection subscribe operation.",
				);
			}
			continue;
		}
		if (operation.kind !== "unsubscribe") {
			throw new FateRequestError("BAD_REQUEST", "Invalid Fate live operation.");
		}
	}
	return value as unknown as LiveControlRequest;
}

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
