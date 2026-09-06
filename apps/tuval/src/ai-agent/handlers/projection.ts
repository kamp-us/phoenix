/**
 * The tail this process publishes, held per process so the Sub and the handlers write one copy.
 *
 * The Sub folds layer events onto a seed of the core's committed state, which is what makes the
 * `transcript` port carry the core's own tail in the core's own order (`./index.ts`). That holds
 * only while every entrance to the transcript is an event, and since #7978 one is not: the `prompt`
 * cell records the operator's turn when they send it, and no layer event ever carries it. A
 * projection the Sub alone owns therefore publishes a transcript with the operator's half missing —
 * the founder's own bug, one surface over from the window (#7979). So the projection lives here,
 * where the `aiAgent.prompt` handler can put it back on the core's committed state.
 *
 * A plain map rather than a `Ref` for `agentSlot`'s reason (`./session.ts`): every read and write
 * of it is synchronous, which on one JS thread is the atomicity a `Ref` would buy.
 */

import {Effect, type Scope} from "effect";
import {ProcessSelf} from "../../process/self.ts";
import type {AiAgentSessionState} from "../core/index.ts";

export interface TranscriptProjection {
	/** Put this process's projection at `state`, replacing whatever stood before. */
	readonly seed: (state: AiAgentSessionState) => Effect.Effect<void, never, ProcessSelf>;
	/**
	 * Fold `step` over the standing projection and answer what it left, or `null` when this process
	 * has none — which is every process whose events Sub has not opened yet.
	 */
	readonly fold: (
		step: (state: AiAgentSessionState) => AiAgentSessionState,
	) => Effect.Effect<AiAgentSessionState | null, never, ProcessSelf>;
}

export const transcriptProjection = (): TranscriptProjection => {
	const held = new WeakMap<Scope.Scope, AiAgentSessionState>();

	const seed = (state: AiAgentSessionState): Effect.Effect<void, never, ProcessSelf> =>
		Effect.map(ProcessSelf, (self) => void held.set(self.scope, state));

	const fold = (
		step: (state: AiAgentSessionState) => AiAgentSessionState,
	): Effect.Effect<AiAgentSessionState | null, never, ProcessSelf> =>
		Effect.map(ProcessSelf, (self) => {
			const standing = held.get(self.scope);
			if (standing === undefined) return null;
			const next = step(standing);
			held.set(self.scope, next);
			return next;
		});

	return {seed, fold};
};
