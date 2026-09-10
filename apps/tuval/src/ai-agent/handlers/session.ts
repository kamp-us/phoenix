/**
 * One `TuvalAiAgent` connection per process, held in a child of that process's own Scope.
 *
 * Ruling 4 (#7570) puts the transport in the layer's build and its teardown in the Scope's close,
 * and makes restore "rebuild the layer, then `start({cwd, resume: sessionId})`". So the slot cannot
 * memoize a built agent for the process's whole life: after a `TransportError` the process stays up
 * holding a dead handle, and a reconnect that reuses it calls `start` on the thing that just died.
 *
 * The child Scope is what makes rebuilding affordable. `Scope.fork` registers it with the process
 * Scope, so a stop still closes the live connection exactly once; closing the child first detaches
 * it, so a process that reconnects ten times does not accumulate ten transports' finalizers on its
 * own Scope (`effect/Scope` rc.112 — "closing the child detaches it from the parent").
 *
 * Only `aiAgent.start` and `aiAgent.reconnect` rebuild, and the core refuses both while an open is
 * in flight (`core/machine.ts`, `busy` and `opening`). That ordering is what makes a plain map safe
 * here without a lock: every other handler reads what the last open left.
 */

import {Context, Effect, Exit, Layer, Scope} from "effect";
import {ProcessSelf} from "../../process/self.ts";
import {TuvalAiAgent, type TuvalAiAgentApi} from "../service/index.ts";

export interface AgentSlot<RIn = never> {
	/**
	 * Tear down this process's previous connection, then build the layer into a fresh child Scope.
	 *
	 * `RIn` is what the layer still asks for. `Layer.buildWithScope` puts a layer's leftover
	 * requirement on the built Effect's own `R` (`effect/Layer` rc.112), and the row carries it out
	 * to the spawn instead of closing it here (#7951).
	 */
	readonly rebuild: Effect.Effect<TuvalAiAgentApi, never, ProcessSelf | RIn>;
	/** What the last `rebuild` left for this process, or `null` when nothing has opened one yet. */
	readonly current: Effect.Effect<TuvalAiAgentApi | null, never, ProcessSelf>;
}

interface Connection {
	readonly scope: Scope.Closeable;
	readonly agent: TuvalAiAgentApi;
}

export const agentSlot = <RIn = never>(
	layer: Layer.Layer<TuvalAiAgent, never, RIn>,
): AgentSlot<RIn> => {
	const held = new WeakMap<Scope.Scope, Connection>();

	const rebuild = Effect.gen(function* () {
		const self = yield* ProcessSelf;
		const previous = held.get(self.scope);
		if (previous !== undefined) {
			// Dropped before the close, so a close that hangs cannot leave a torn-down agent readable.
			held.delete(self.scope);
			yield* Scope.close(previous.scope, Exit.void);
		}
		const scope = yield* Scope.fork(self.scope);
		const context = yield* Layer.buildWithScope(layer, scope);
		const agent = Context.get(context, TuvalAiAgent);
		held.set(self.scope, {scope, agent});
		return agent;
	});

	const current = Effect.map(ProcessSelf, (self) => held.get(self.scope)?.agent ?? null);

	return {rebuild, current};
};
