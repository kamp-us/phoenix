/**
 * One `TuvalAiAgent` per process, acquired in that process's own Scope.
 *
 * Ruling 4 (#7570): building the layer acquires the transport and closing the Scope tears it down,
 * so the acquisition belongs to the process's lifetime and not to a Cmd's. `ProcessSelf` hands a
 * handler its own process's Scope (#7513), and the memo below is keyed on that Scope object: two
 * processes of one program are two keys, so they never share a transport, and a stopped process's
 * key is unreachable, so nothing keeps it alive.
 *
 * Only `aiAgent.start` and `aiAgent.reconnect` acquire. Every other handler reads what they left,
 * because the core will not emit their Cmds before `started`, and the events Sub does not exist
 * until the session has an id. That ordering is what makes a plain map safe here without a lock.
 */

import {Context, Effect, Layer, type Scope} from "effect";
import {ProcessSelf} from "../../process/self.ts";
import {TuvalAiAgent, type TuvalAiAgentApi} from "../service/index.ts";

export interface AgentSlot {
	/** Build the layer into the process's Scope on first call; hand back the same agent after. */
	readonly acquire: Effect.Effect<TuvalAiAgentApi, never, ProcessSelf>;
	/** What `acquire` left for this process, or `null` when nothing has started it yet. */
	readonly current: Effect.Effect<TuvalAiAgentApi | null, never, ProcessSelf>;
}

export const agentSlot = (layer: Layer.Layer<TuvalAiAgent>): AgentSlot => {
	const held = new WeakMap<Scope.Scope, TuvalAiAgentApi>();

	const acquire = Effect.gen(function* () {
		const self = yield* ProcessSelf;
		const existing = held.get(self.scope);
		if (existing !== undefined) return existing;
		// `buildWithScope`, not `build`: the resources go to the process's Scope rather than to
		// whatever Scope this Cmd happens to run under (`Layer.buildWithScope`, `effect/Layer`
		// rc.112 — "released when the supplied scope is closed").
		const context = yield* Layer.buildWithScope(layer, self.scope);
		const agent = Context.get(context, TuvalAiAgent);
		held.set(self.scope, agent);
		return agent;
	});

	const current = Effect.map(ProcessSelf, (self) => held.get(self.scope) ?? null);

	return {acquire, current};
};
