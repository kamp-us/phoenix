/**
 * `LivePublisher` — the per-request live-publish CONTRACT only; the layer that
 * implements it (waitUntil scheduling, error swallowing-with-log, LiveDO topic
 * targeting) is worker-side, in
 * `apps/web/worker/features/fate-live/live-publisher.ts`. Every publish
 * method's error channel is `never`, so "a publish cannot fail the mutation"
 * is a type rather than a convention.
 *
 * Entity/procedure names are plain strings: the package cannot know phoenix's
 * live entities. Like `CurrentUser`, no worker-level layer provides this — the
 * provision pipeline (`Provision.ts`) provides it per request, and
 * `FateServer.layer` excludes it from R (`FateServerRequirements`).
 */
import {Context, type Effect} from "effect";

export interface LiveUpdateOptions {
	readonly changed?: ReadonlyArray<string>;
	readonly data?: unknown;
	readonly eventId?: string;
}

export interface LiveEventOptions {
	readonly eventId?: string;
}

export interface LiveEdgeOptions {
	readonly node?: unknown;
	readonly cursor?: string;
	readonly eventId?: string;
}

export interface LiveTopicPublisher {
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
 *     yield* live.topic("Term.definitions", {slug: input.slug}).appendNode("Definition", definition.id, {node: definition});
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
		readonly topic: (procedure: string, args?: Record<string, unknown>) => LiveTopicPublisher;
	}
>()("fate-effect/LivePublisher") {}
