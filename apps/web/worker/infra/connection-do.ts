/**
 * `ConnectionDO` — the connection-role half of phoenix's live fan-out (ADR 0023,
 * split per ADR 0025), declared on alchemy's Effect Durable Object model
 * (ADR 0028).
 *
 * FOUNDATION STUB (alchemy-migration task 1). This is the **inline-form**
 * `DurableObjectNamespace` declaration so the worker can bind it and alchemy can
 * derive its migration — it carries no behavior yet. Task 5 ports the real
 * connection logic (held SSE stream, subscription list, persisted `generation`,
 * typed `deliver`/`probe` RPC) off the legacy `cloudflare:workers` class in
 * `worker/fate/connection-do.ts` into this Effect-model shape.
 *
 * The inline form is mandatory: the modular `.make()` form is documented but
 * unimplemented for DOs in alchemy@2.0.0-beta.44 (ADR 0028). Cross-DO calls
 * (the `ConnectionDO`↔`TopicDO` fan-out) must resolve the sibling lazily inside
 * an RPC method body — never `yield* TopicDO` in this init block (it OOMs the
 * build; ADR 0028).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default class ConnectionDO extends Cloudflare.DurableObjectNamespace<ConnectionDO>()(
	"ConnectionDO",
	Effect.gen(function* () {
		// init phase — no shared bindings resolved yet (task 5 wires the topic
		// namespace lazily, inside the RPC methods, not here).
		return Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			return {
				// Placeholder RPC so the namespace has a typed shape. Replaced by the
				// real connection API (deliver/probe + the held SSE stream) in task 5.
				ping: () => Effect.as(state.storage.get<number>("generation"), "pong" as const),
			};
		});
	}),
) {}
