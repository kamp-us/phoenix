/**
 * `LivePublisher` — the per-request live-publish service, the other half of
 * the server's per-request contract (`CurrentUser` is the first half).
 *
 * THIS MODULE DEFINES THE CONTRACT ONLY. The live layer — waitUntil
 * scheduling, error swallowing-with-log, the LiveDO topic targeting — is
 * worker-side (`apps/web/worker/features/fate-live/live-publisher.ts`), and
 * it lives there ONCE, so "a publish cannot fail the
 * mutation" is a type, not a convention: every publish method's error channel
 * is `never` (`Effect.Effect<void>`), which is what kills the bridge's
 * per-call-site `useIgnore` boilerplate.
 *
 * The surface mirrors the publish half of the bridge's event-bus
 * (`apps/web/worker/features/fate-live/event-bus.ts`): entity `update`/
 * `delete` plus the connection edge operations, targeting the existing LiveDO
 * topic role unchanged. Entity/procedure names are plain strings here — the
 * package cannot know phoenix's live entities; the worker may layer its
 * narrowing (the bridge's `TypedLiveUpdate` idea) over this service when it
 * migrates.
 *
 * Like `CurrentUser`, no worker-level layer provides this: the provision
 * pipeline (`Provision.ts`) provides it per request from the request's
 * execution context, and
 * `FateServer.layer` excludes it from R (`FateServerRequirements`).
 */
import {Context, type Effect} from "effect";

/** Options for an entity `update` publish. */
export interface LiveUpdateOptions {
	readonly changed?: ReadonlyArray<string>;
	readonly data?: unknown;
	readonly eventId?: string;
}

/** Options shared by publishes that only carry an event id. */
export interface LiveEventOptions {
	readonly eventId?: string;
}

/** Options for a connection edge publish (`appendNode`/`prependNode`). */
export interface LiveEdgeOptions {
	readonly node?: unknown;
	readonly cursor?: string;
	readonly eventId?: string;
}

/**
 * The publish surface of one live connection (procedure + scoped args):
 * append/prepend a node, remove an edge, or invalidate. Every method is
 * `Effect<void>` — failures are swallowed (logged) inside the layer.
 */
export interface LiveConnectionPublisher {
	readonly appendNode: (
		nodeType: string,
		id: string | number,
		options?: LiveEdgeOptions,
	) => Effect.Effect<void>;
	readonly prependNode: (
		nodeType: string,
		id: string | number,
		options?: LiveEdgeOptions,
	) => Effect.Effect<void>;
	readonly deleteEdge: (
		nodeType: string,
		id: string | number,
		options?: LiveEventOptions,
	) => Effect.Effect<void>;
	readonly invalidate: (options?: LiveEventOptions) => Effect.Effect<void>;
}

/**
 * Per-request live publishing. Yield it in a mutation handler and publish —
 * no `useIgnore`, no error channel:
 *
 * @example
 *   Effect.fn("definition.add")(function* ({input}) {
 *     ...
 *     const live = yield* LivePublisher;
 *     yield* live.connection("Term.definitions", {slug: input.slug}).appendNode("Definition", definition.id, {node: definition});
 *   })
 */
export class LivePublisher extends Context.Service<
	LivePublisher,
	{
		readonly update: (
			type: string,
			id: string | number,
			options?: LiveUpdateOptions,
		) => Effect.Effect<void>;
		readonly delete: (
			type: string,
			id: string | number,
			options?: LiveEventOptions,
		) => Effect.Effect<void>;
		readonly connection: (
			procedure: string,
			args?: Record<string, unknown>,
		) => LiveConnectionPublisher;
	}
>()("fate-effect/LivePublisher") {}
