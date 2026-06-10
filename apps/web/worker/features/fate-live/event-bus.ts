/**
 * The publish-only `LiveEventBus` core (ADR 0023/0039, `.patterns/fate-live-views.md`).
 *
 * fate's built-in `createLiveEventBus()` is an in-memory `EventEmitter`: a
 * `live.update` reaches only subscribers in the **same** Worker isolate, so it
 * cannot fan out across the isolates a Worker spreads requests over. phoenix
 * keeps fate's SSE wire protocol but moves the connection-owning and fan-out
 * into the unified `LiveDO` Durable Object (`live-do.ts`).
 *
 * This module is the **publish** side: `update`/`delete`/`connection().*`
 * resolve a topic string and hand the **inline-resolved** `data`/`node` the
 * mutation already produced for its own response to a {@link LivePublisher} —
 * so the DO does no database work and needs no Effect runtime. `subscribe`/
 * `subscribeConnection` throw (never called — the SSE protocol is served by the
 * `/fate/live` route + DO, not by fate's `handleLiveRequest`), but the
 * `subscribe` property must exist because fate detects a custom bus by
 * `"subscribe" in live`.
 *
 * Mutations publish through `@phoenix/fate-effect`'s `LivePublisher`
 * per-request service — `live-publisher.ts` wraps {@link makeLiveEventBus}
 * over the request's `LiveTopics` publish + `waitUntil`, so this module stays
 * the ONE frame-building code path and the wire shape ({@link PublishMessage})
 * cannot drift between the request path and the static config bus.
 */

import type {LiveEventBus} from "@nkzw/fate/server";
import * as Schema from "effect/Schema";
import type {ConnectionFrame, EntityFrame, PublishMessage} from "./protocol.ts";
import {topicsForPublish} from "./protocol.ts";

/**
 * A pre-bound per-request publisher: hand it one resolved topic key + the
 * publish message and it fires the typed `LiveDO.publish` RPC (on the
 * `topic:<key>`-named instance), fired-and-forgotten via the request's
 * `waitUntil`. `live-publisher.ts` builds this from the worker-init-resolved
 * `LiveDO` namespace (`getByName`, typed RPC) and
 * `Cloudflare.WorkerExecutionContext.waitUntil` — so the bus reaches the DO via
 * the typed RPC stub, not an `env`-lookup/`idFromName`/string-URL `stub.fetch`
 * (ADR 0028/0029).
 */
export type LivePublisher = (topicKey: string, message: PublishMessage) => void;

/**
 * A publish failed inside the live publisher's swallow wrapper
 * (`live-publisher.ts`). It never reaches the fate boundary: a mutation
 * publishes *after* its DB write, so the publish must not be able to fail the
 * committed mutation — the publisher maps this away (logged at `Warn`) in its
 * `never` error channel (ADR 0039's use/useIgnore law, applied once inside
 * the layer).
 */
export class LivePublishError extends Schema.TaggedErrorClass<LivePublishError>()(
	"fate-live/LivePublishError",
	{
		cause: Schema.Defect(),
	},
) {}

function publish(publisher: LivePublisher, message: PublishMessage): void {
	for (const topicKey of topicsForPublish(message)) {
		publisher(topicKey, message);
	}
}

/** Build the fate entity frame for an update/delete publish. */
function entityFrame(
	type: "update" | "delete",
	id: string | number,
	options?: {data?: unknown; select?: ReadonlyArray<string>},
): EntityFrame {
	if (type === "delete") {
		return {delete: true, id};
	}
	return {
		data: options?.data,
		...(options?.select ? {select: [...options.select]} : {}),
	};
}

/**
 * Build the publish-only fluent bus over one {@link LivePublisher}, at fate's
 * own `LiveEventBus` typing. This is the ONE frame-building code path — every
 * publish surface derives from it, so the wire shape ({@link PublishMessage})
 * cannot drift between surfaces:
 *
 *   - `live-publisher.ts` wraps it as the package's `LivePublisher`
 *     per-request service (the publish surface every mutation uses);
 *   - {@link liveBusConfig} is the same constructor over a no-op publisher,
 *     for `createFateServer`'s `live` option (subscribe-detection only).
 *
 * Every `update`/`delete`/`connection().*` resolves a topic and hands the
 * inline-resolved frame to `publisher`; `subscribe`/`subscribeConnection`
 * throw.
 */
export function makeLiveEventBus(publisher: LivePublisher): LiveEventBus {
	return {
		update: (type, id, options) => {
			publish(publisher, {
				kind: "entity",
				match: {type, entityId: String(id)},
				frame: entityFrame("update", id, options),
				...(options?.eventId !== undefined ? {eventId: options.eventId} : {}),
			});
		},
		delete: (type, id, options) => {
			publish(publisher, {
				kind: "entity",
				match: {type, entityId: String(id)},
				frame: entityFrame("delete", id),
				...(options?.eventId !== undefined ? {eventId: options.eventId} : {}),
			});
		},
		connection: (procedure, args) => {
			// Carry the connection's filter args into the publish match so
			// `topicsForPublish` resolves the SAME args-scoped `liveConnectionTopic`
			// key the subscriber registered under — the publish hits the narrow topic
			// directly instead of falling back to the procedure-wide global wildcard
			// (which would fan one term's new definition out to every `Term.definitions`
			// subscriber across all slugs/tabs/sessions).
			const match = {procedure, ...(args !== undefined ? {args} : {})};
			const emit = (frame: ConnectionFrame, eventId?: string) =>
				publish(publisher, {
					kind: "connection",
					match,
					frame,
					...(eventId !== undefined ? {eventId} : {}),
				});
			const edgeFrame = (
				type:
					| "appendEdge"
					| "appendNode"
					| "insertEdgeAfter"
					| "insertEdgeBefore"
					| "prependEdge"
					| "prependNode",
				nodeType: string,
				options?: {node?: unknown; cursor?: string; targetCursor?: string},
			): ConnectionFrame => ({
				type,
				nodeType,
				edge: {node: options?.node, ...(options?.cursor ? {cursor: options.cursor} : {})},
				...(options?.targetCursor ? {targetCursor: options.targetCursor} : {}),
			});
			return {
				appendEdge: (nodeType, _id, options) =>
					emit(edgeFrame("appendEdge", nodeType, options), options?.eventId),
				appendNode: (nodeType, _id, options) =>
					emit(edgeFrame("appendNode", nodeType, options), options?.eventId),
				prependEdge: (nodeType, _id, options) =>
					emit(edgeFrame("prependEdge", nodeType, options), options?.eventId),
				prependNode: (nodeType, _id, options) =>
					emit(edgeFrame("prependNode", nodeType, options), options?.eventId),
				insertEdgeAfter: (nodeType, _id, targetCursor, options) =>
					emit(
						edgeFrame("insertEdgeAfter", nodeType, {...options, targetCursor}),
						options?.eventId,
					),
				insertEdgeBefore: (nodeType, _id, targetCursor, options) =>
					emit(
						edgeFrame("insertEdgeBefore", nodeType, {...options, targetCursor}),
						options?.eventId,
					),
				deleteEdge: (nodeType, id, options) =>
					emit({type: "deleteEdge", nodeType, id}, options?.eventId),
				invalidate: (options) => emit({type: "invalidate"}, options?.eventId),
				emit: (type, options) => {
					if (type === "deleteEdge") {
						emit(
							{type, nodeType: options?.nodeType ?? "", id: options?.id ?? ""},
							options?.eventId,
						);
					} else if (type === "invalidate") {
						emit({type: "invalidate"}, options?.eventId);
					} else {
						emit(edgeFrame(type, options?.nodeType ?? "", options), options?.eventId);
					}
				},
			};
		},
		emit: (type, id, options) => {
			const eventType = options?.type ?? "update";
			publish(publisher, {
				kind: "entity",
				match: {type, entityId: String(id)},
				frame: entityFrame(eventType, id, options),
				...(options?.eventId !== undefined ? {eventId: options.eventId} : {}),
			});
		},
		subscribe: () => {
			throw new Error("live subscriptions are served by LiveDO, not the bus");
		},
		subscribeConnection: () => {
			throw new Error("live subscriptions are served by LiveDO, not the bus");
		},
	};
}

/**
 * The publish-only bus handed to fate at worker init (`createFateServer`'s
 * `live` config). fate only ever touches the **subscribe** side of this object
 * (`"subscribe" in live` detection — phoenix throws on the actual subscribe), so
 * its publisher is a no-op: mutations publish through the per-request
 * `LivePublisher` service, never through this static singleton. Kept fat (the
 * full fluent surface) so fate's `LiveEventBus` structural check passes; the
 * publish methods are vestigial.
 */
export const liveBusConfig: LiveEventBus = makeLiveEventBus(() => {});
