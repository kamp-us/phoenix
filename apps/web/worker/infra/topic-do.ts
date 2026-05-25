/**
 * `TopicDO` — the topic-role half of phoenix's live fan-out (ADR 0023, split per
 * ADR 0025), declared on alchemy's Effect Durable Object model (ADR 0028).
 *
 * FOUNDATION STUB (alchemy-migration task 1). Inline-form
 * `DurableObjectNamespace` declaration so the worker can bind it and alchemy can
 * derive its migration — no behavior yet. Task 5 ports the real topic logic
 * (durable subscriber registry in `state.storage.sql`, the `publish` fan-out,
 * the alarm reap) off the legacy `cloudflare:workers` class in
 * `worker/fate/topic-do.ts` into this Effect-model shape, resolving the
 * `ConnectionDO` sibling lazily inside the `publish` RPC (never in init).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO>()(
	"TopicDO",
	Effect.gen(function* () {
		// init phase — no shared bindings resolved yet. The ConnectionDO sibling is
		// resolved lazily in the publish RPC (task 5), never here (eager
		// `yield* ConnectionDO` OOMs the build; ADR 0028).
		return Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			return {
				// Placeholder RPC so the namespace has a typed shape. Replaced by the
				// real topic API (register/deregister/publish) in task 5.
				ping: () => Effect.as(state.storage.get<number>("count"), "pong" as const),
			};
		});
	}),
) {}
