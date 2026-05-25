/**
 * `TopicDO` — the topic-role half of phoenix's live fan-out (ADR 0023, split per
 * ADR 0025), on alchemy's Effect Durable Object model (ADR 0028).
 *
 * One instance per topic, named `topic:<topicKey>`. It owns the **durable
 * subscriber registry** for that topic (in `state.storage.sql`), the **publish
 * fan-out**, and the **alarm reap** — nothing about any client's SSE stream.
 * The algorithm (generation-based stale detection, the consecutive-miss reap, the
 * bounded fan-out) is a verbatim port of the legacy `cloudflare:workers` class;
 * the behavior lives in `makeTopicInstance` (`live-instance.ts`), this file is
 * the inline-form `DurableObjectNamespace` declaration that wires it up.
 *
 * **Inline form is mandatory** — the modular `.make()` form is unimplemented for
 * DOs in alchemy@2.0.0-beta.44 (ADR 0028). The `ConnectionDO` sibling is resolved
 * **lazily inside `publish`/`alarm`** (`yield* ConnectionDO` per call) and
 * addressed by name (`getByName(\`connection:${id}\`)`) — never `yield*
 * ConnectionDO` in the init block (an eager circular `yield*` OOMs the build) and
 * never `idFromName`/`idFromString`/`get` (unavailable on the alchemy stub).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import ConnectionDO from "./connection-do.ts";
import {type ConnectionRpc, makeTopicInstance} from "./live-instance.ts";

/**
 * Opaque, lazily-read view of the `ConnectionDO` sibling namespace — only its
 * `getByName(...).deliver/probe` typed RPC is needed here. It is read through a
 * **function** (not a module-top-level const) for two reasons: (1) referencing
 * the sibling's full class type would form a circular type cycle, so the cast is
 * the seam that breaks it; (2) the import is genuinely circular at runtime, so a
 * top-level `ConnectionDO` access would hit the temporal dead zone while
 * `connection-do.ts` is still evaluating — deferring the read to call time (well
 * after both modules have loaded) sidesteps that (ADR 0028).
 */
const connectionNamespace = (): Effect.Effect<
	{readonly getByName: (name: string) => ConnectionRpc},
	never,
	Cloudflare.Worker
> => ConnectionDO as never;

export default class TopicDO extends Cloudflare.DurableObjectNamespace<TopicDO>()(
	"TopicDO",
	Effect.gen(function* () {
		// ── SHARED INIT (once per namespace) ──
		// Do NOT resolve the ConnectionDO sibling here. An eager `yield* ConnectionDO`
		// in init — paired with `yield* TopicDO` in ConnectionDO's init — is a
		// circular binding that OOMs the build (ADR 0028). Resolve it lazily, per
		// call, inside publish/alarm (below).
		return Effect.gen(function* () {
			// ── PER-INSTANCE (once per instance wake) ──
			const state = yield* Cloudflare.DurableObjectState;
			return makeTopicInstance(state, (connectionId) =>
				// Lazy sibling resolution: `yield* ConnectionDO` happens here, per fan-out
				// call, never in init. Addressed by the human-readable connection name.
				Effect.gen(function* () {
					const connections = yield* connectionNamespace();
					return connections.getByName(`connection:${connectionId}`);
				}),
			);
		});
	}),
) {}
