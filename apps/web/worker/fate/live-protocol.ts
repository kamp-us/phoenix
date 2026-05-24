/**
 * Shared live wire types + topic helpers for the SSE fan-out (ADR 0023).
 *
 * This module is import-safe in a plain Node runner (no `cloudflare:workers`):
 * the publish-only `liveBus` (`live.ts`) and the fate codegen graph
 * (`schema.ts → server.ts → live.ts`) depend on it, while only the `LiveDO`
 * class (`live-do.ts`) and the worker entry pull in the Workers runtime. Keeping
 * the frame shapes + topic resolution here means the bus, the DO, and the route
 * all speak one vocabulary.
 *
 * The frame shapes mirror fate's native `livePayload` / `liveConnectionPayload`
 * / `sse()` exactly, so the browser's native fate SSE client parses them
 * unchanged — phoenix only swaps where the frames are produced (the DO, from
 * inline-published data), not their shape.
 */
import {liveConnectionTopic, liveEntityTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";

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
			readonly match: {readonly procedure: string};
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
	// topic, so `live.connection("posts")` reaches every feed-sort variant.
	return [
		liveConnectionTopic(message.match.procedure),
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
