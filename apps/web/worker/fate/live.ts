/**
 * The publish-only `LiveEventBus` (ADR 0023, `.patterns/fate-live-views.md`).
 *
 * fate's built-in `createLiveEventBus()` is an in-memory `EventEmitter`: a
 * `live.update` reaches only subscribers in the **same** Worker isolate, so it
 * cannot fan out across the isolates a Worker spreads requests over. phoenix
 * keeps fate's SSE wire protocol but moves the connection-owning and fan-out
 * into the `LiveDO` Durable Object (`live-do.ts`).
 *
 * This module is the **publish** side: `update`/`delete`/`connection().*`
 * resolve a topic string and `fetch` the topic DO with the **inline-resolved**
 * `data`/`node` the mutation already produced for its own response — so the DO
 * does no database work and needs no Effect runtime. `subscribe`/
 * `subscribeConnection` throw (never called — the SSE protocol is served by the
 * `/fate/live` route + DO, not by fate's `handleLiveRequest`), but the
 * `subscribe` property must exist because fate detects a custom bus by
 * `"subscribe" in live`.
 *
 * Import-safe in a plain Node runner (`node:async_hooks` resolves both in the
 * Node codegen runner and in the Workers runtime under `nodejs_compat`; unlike
 * `cloudflare:workers`, which the codegen runner can't resolve), so the fate
 * codegen graph (`schema.ts → server.ts → live.ts`) loads it without the
 * Workers runtime. The `LIVE_DO` binding is reached at runtime through
 * {@link livePublishContext}.
 */
import {AsyncLocalStorage} from "node:async_hooks";
import type {LiveEventBus} from "@nkzw/fate/server";
import type {ConnectionFrame, EntityFrame, PublishMessage} from "./live-protocol";
import {topicsForPublish} from "./live-protocol";

/**
 * Per-request publish context. The `/fate` route runs the operation inside
 * `livePublishContext.run({env, waitUntil}, …)` so the synchronous `live.*`
 * publish methods can resolve the `LIVE_DO` binding and `waitUntil` the fan-out
 * (so it doesn't block the mutation response). Outside a request (e.g. the bus
 * imported in isolation, or a query that publishes nothing), publishes no-op.
 */
export const livePublishContext = new AsyncLocalStorage<{
	env: Env;
	waitUntil: (promise: Promise<unknown>) => void;
}>();

/** Resolve a topic-role DO stub by topic key from the ambient publish context. */
function topicStubFor(env: Env, topicKey: string) {
	return env.LIVE_DO.get(env.LIVE_DO.idFromName(`topic:${topicKey}`));
}

/** Forward a publish message to every topic DO it targets, via `waitUntil`. */
function publish(message: PublishMessage): void {
	const store = livePublishContext.getStore();
	if (!store) {
		// No ambient request (bus used outside the live path) — nothing to fan out.
		return;
	}
	const {env, waitUntil} = store;
	for (const topicKey of topicsForPublish(message)) {
		waitUntil(
			topicStubFor(env, topicKey)
				.fetch("https://live/publish", {
					method: "POST",
					body: JSON.stringify(message),
				})
				.then(
					() => undefined,
					// A failed topic-DO fetch must not become a silent unhandled
					// rejection inside `waitUntil`; the publish is best-effort (the
					// mutation response already succeeded), so swallow it loudly.
					(error: unknown) => {
						console.error(`live publish to topic:${topicKey} failed`, error);
					},
				),
		);
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
 * phoenix's publish-only `LiveEventBus`. Every `update`/`delete`/`connection().*`
 * resolves a topic and fetches the topic DO with the inline-resolved data the
 * mutation already produced; `subscribe`/`subscribeConnection` throw.
 */
export const liveBus: LiveEventBus = {
	update: (type, id, options) => {
		publish({
			kind: "entity",
			match: {type, entityId: String(id)},
			frame: entityFrame("update", id, options),
			...(options?.eventId !== undefined ? {eventId: options.eventId} : {}),
		});
	},
	delete: (type, id, options) => {
		publish({
			kind: "entity",
			match: {type, entityId: String(id)},
			frame: entityFrame("delete", id),
			...(options?.eventId !== undefined ? {eventId: options.eventId} : {}),
		});
	},
	connection: (procedure, _args) => {
		const match = {procedure} as const;
		const emit = (frame: ConnectionFrame, eventId?: string) =>
			publish({
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
				emit(edgeFrame("insertEdgeAfter", nodeType, {...options, targetCursor}), options?.eventId),
			insertEdgeBefore: (nodeType, _id, targetCursor, options) =>
				emit(edgeFrame("insertEdgeBefore", nodeType, {...options, targetCursor}), options?.eventId),
			deleteEdge: (nodeType, id, options) =>
				emit({type: "deleteEdge", nodeType, id}, options?.eventId),
			invalidate: (options) => emit({type: "invalidate"}, options?.eventId),
			emit: (type, options) => {
				if (type === "deleteEdge") {
					emit({type, nodeType: options?.nodeType ?? "", id: options?.id ?? ""}, options?.eventId);
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
		publish({
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
