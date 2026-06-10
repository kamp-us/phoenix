/**
 * The publish-only `LiveEventBus` (ADR 0023/0039, `.patterns/fate-live-views.md`).
 *
 * fate's built-in `createLiveEventBus()` is an in-memory `EventEmitter`: a
 * `live.update` reaches only subscribers in the **same** Worker isolate, so it
 * cannot fan out across the isolates a Worker spreads requests over. phoenix
 * keeps fate's SSE wire protocol but moves the connection-owning and fan-out
 * into the unified `LiveDO` Durable Object (`live-do.ts`).
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
 * The per-request publisher (the typed `TopicDO.publish` RPC, closing over
 * `waitUntil` + the worker-init `LiveTopics` namespace) is acquired in Effect
 * world via the {@link LiveBus} `Context.Service` (ADR 0039) — `yield* LiveBus`
 * in a mutation resolver, then `liveBus.useIgnore(bus => bus.connection(...))`.
 * There is no `node:async_hooks` / `AsyncLocalStorage` bridge: the bus is
 * provided per request in the `/fate` route exactly where `Auth` is, so a
 * missing provide fails loudly instead of silently no-opping.
 */

import type {LiveEventBus} from "@nkzw/fate/server";
import {Context, Effect} from "effect";
import * as Schema from "effect/Schema";
import type {LiveChangedField, LiveEntities} from "../fate/views.ts";
import type {
	ConnectionFrame,
	EntityFrame,
	LiveConnectionProcedure,
	PublishMessage,
} from "./protocol.ts";
import {topicsForPublish} from "./protocol.ts";

/**
 * Typed `update` for the publish-only bus: the entity name is constrained to the
 * known live entities ({@link LiveEntities}) and `changed` is typed against that
 * entity's own field keys ({@link LiveChangedField}) rather than a bare
 * `string[]`. A typo (`["scor"]`) or a renamed field is a compile error at the
 * mutation site instead of a silently-ignored no-op. `data` is the entity the
 * mutation already resolved for its response.
 */
type TypedLiveUpdate = <Name extends keyof LiveEntities>(
	type: Name,
	id: string | number,
	options?: {
		changed?: ReadonlyArray<LiveChangedField<Name>>;
		data?: LiveEntities[Name];
		eventId?: string;
	},
) => void;

/**
 * Typed `connection` for the publish-only bus: the procedure name is constrained
 * to the known live connections ({@link LiveConnectionProcedure}) rather than a
 * bare `string`. A typo (`"post"`) silently creates a dead topic — publish and
 * subscribe key off different strings and miss each other with no failure — so
 * the typo becomes a compile error at the mutation site, exactly as
 * {@link TypedLiveUpdate} does for the entity seam. The returned handle is fate's
 * own `LiveConnectionHandle` (only the procedure argument is narrowed).
 */
type TypedLiveConnection = (
	procedure: LiveConnectionProcedure,
	args?: Record<string, unknown>,
) => ReturnType<LiveEventBus["connection"]>;

/**
 * phoenix's bus is fate's `LiveEventBus` with a stricter `update` and
 * `connection`: callers see the entity-keyed `update` ({@link TypedLiveUpdate})
 * and the procedure-keyed `connection` ({@link TypedLiveConnection}), while
 * `server.ts` still passes it where a `LiveEventBus` is expected (each narrower
 * signature is assignable to its looser `(type: string, …)` counterpart).
 */
export type PhoenixLiveEventBus = Omit<LiveEventBus, "connection" | "update"> & {
	connection: TypedLiveConnection;
	update: TypedLiveUpdate;
};

/**
 * A pre-bound per-request publisher: hand it one resolved topic key + the
 * publish message and it fires the typed `LiveDO.publish` RPC (on the
 * `topic:<key>`-named instance), fired-and-forgotten via the request's
 * `waitUntil`. The `/fate` route builds this from the worker-init-resolved
 * `LiveDO` namespace (`getByName`, typed RPC) and
 * `Cloudflare.WorkerExecutionContext.waitUntil` — so the bus reaches the DO via
 * the typed RPC stub, not an `env`-lookup/`idFromName`/string-URL `stub.fetch`
 * (ADR 0028/0029).
 */
export type LivePublisher = (topicKey: string, message: PublishMessage) => void;

/**
 * A publish failed inside {@link LiveBus.use}. Surfaced (typed) by `use`,
 * swallowed-with-log by `useIgnore`. It never reaches the fate boundary: a
 * mutation publishes *after* its DB write, so the publish must not be able to
 * fail the committed mutation — `useIgnore` (the only caller) maps this away in
 * its `never` error channel. There is therefore no `WIRE_CODE_BY_TAG` entry.
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
 * own loose `LiveEventBus` typing (`string` entity/procedure params). This is
 * the ONE frame-building code path — every publish surface derives from it, so
 * the wire shape ({@link PublishMessage}) cannot drift between surfaces:
 *
 *   - {@link makeLiveBus} narrows it to the bridge's typed
 *     {@link PhoenixLiveEventBus} (param contravariance: the loose bus accepts
 *     any string, so the narrowing is a plain assignment, no cast);
 *   - `live-publisher.ts` wraps it as the package's string-typed
 *     `LivePublisher` per-request service (the post-bridge publish surface).
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
 * The bridge's typed view over {@link makeLiveEventBus}: the same bus value at
 * the stricter {@link PhoenixLiveEventBus} surface (entity-keyed `update`,
 * procedure-keyed `connection`). Pure narrowing by assignment — the loose bus
 * accepts any string, so each narrower signature is satisfied contravariantly;
 * no cast, no second implementation.
 */
export function makeLiveBus(publisher: LivePublisher): PhoenixLiveEventBus {
	return makeLiveEventBus(publisher);
}

/**
 * The publish-only bus handed to fate at worker init (`createFateServer`'s
 * `live` config). fate only ever touches the **subscribe** side of this object
 * (`"subscribe" in live` detection — phoenix throws on the actual subscribe), so
 * its publisher is a no-op: mutations publish through {@link LiveBus}, never
 * through this static singleton. Kept fat (the full fluent surface) so fate's
 * `LiveEventBus` structural check passes; the publish methods are vestigial.
 */
export const liveBus: PhoenixLiveEventBus = makeLiveBus(() => {});

/**
 * The same no-op bus at fate's own `LiveEventBus` typing for `createFateServer`'s
 * `live` config (`server.ts` consumes this, subscribe-only role) — built from
 * the loose constructor directly, so no widening cast is needed.
 */
export const liveBusConfig: LiveEventBus = makeLiveEventBus(() => {});

/**
 * The per-request publish capability, acquired in Effect world (ADR 0039). A
 * mutation resolver does `const liveBus = yield* LiveBus`, then wraps each sync
 * publish as `yield* liveBus.useIgnore(bus => bus.connection(...).appendNode(...))`.
 *
 * Modeled on effect-smol's `NodeRedis.use` (adapted to a synchronous client):
 * `use` SURFACES a typed {@link LivePublishError}; `useIgnore` swallows it
 * (logged at `Warn`) so a mutation can never fail because its post-write publish
 * failed. The void contract is the type, not a convention — `useIgnore` returns
 * `Effect<void, never>` and Effect short-circuits on yielded errors, so the
 * empty error channel makes a publish failure unable to fail the committed
 * mutation it follows.
 */
export class LiveBus extends Context.Service<
	LiveBus,
	{
		/**
		 * Run `f(bus)` synchronously, surfacing a typed {@link LivePublishError}.
		 * The base primitive `useIgnore` is defined in terms of (`use(f).pipe(…)`);
		 * intentionally retained as the named half of the `use`/`useIgnore` pattern
		 * even though every current mutation publishes via `useIgnore` — do not
		 * "clean up" as unused (ADR 0039).
		 */
		readonly use: <A>(f: (bus: PhoenixLiveEventBus) => A) => Effect.Effect<A, LivePublishError>;
		/**
		 * Run `f(bus)`, swallowing any failure (logged at `Warn`). Mandatory for
		 * mutation publishes: the publish sits after the DB write, so it must not be
		 * able to fail the committed mutation. The empty error channel
		 * (`Effect<void, never>`) is the contract — not a convention (ADR 0039).
		 */
		readonly useIgnore: (f: (bus: PhoenixLiveEventBus) => unknown) => Effect.Effect<void, never>;
	}
>()("@phoenix/fate-live/LiveBus") {}

/**
 * Build a {@link LiveBus} value over one {@link PhoenixLiveEventBus}. `use` wraps
 * the synchronous client call in `Effect.try` (sync → `try`, not `tryPromise`).
 * Shared by both the live and test layers — the only thing that varies between
 * them is which bus (which publisher) is closed over.
 */
function makeLiveBusService(bus: PhoenixLiveEventBus): typeof LiveBus.Service {
	const use = <A>(f: (bus: PhoenixLiveEventBus) => A) =>
		Effect.try({try: () => f(bus), catch: (cause) => new LivePublishError({cause})});
	// `useIgnore` IS `use` then `Effect.ignore` — the law the ADR/pattern state, so
	// the `LivePublishError` mapping lives in one place and can't drift; `ignore`
	// gives the `Effect<void, never>` the void contract rests on.
	return {use, useIgnore: (f) => use(f).pipe(Effect.ignore({log: "Warn"}))};
}

/**
 * Provide {@link LiveBus} over a ready-made {@link LivePublisher} — the
 * per-request shape the `/fate` route uses. The route builds the publisher from
 * `LiveTopics` + `Cloudflare.WorkerExecutionContext.waitUntil` and provides this
 * with `Effect.provideService(LiveBus, liveBusFor(publisher))`, exactly where it
 * provides `Auth`.
 */
export function liveBusFor(publisher: LivePublisher): typeof LiveBus.Service {
	return makeLiveBusService(makeLiveBus(publisher));
}
