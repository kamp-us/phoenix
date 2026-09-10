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
 * `seed` rebases rather than replaces, and #8034 is why. The Sub dispatches an event and folds it
 * in the same breath, and the host applies a dispatched Msg on a forked fiber that has to take the
 * transition tail first (`../../host/actor.ts`), so the projection legitimately leads the committed
 * state. A Cmd handler runs inside the permit its own commit holds, which puts it strictly ahead of
 * every event Msg still queued — so a plain replace drops whatever the Sub folded in that gap, and
 * drops it for good, because the Sub folds each event exactly once.
 *
 * The committed state stays the authority for everything else on purpose: the pending cards and the
 * mode are what the core holds, and re-seeding those is how an answer's own progress reaches a
 * projection no event will ever push forward (#8006). Only the transcript is carried across, and
 * only its tail past the last item the commit names — an item older than that and absent from the
 * commit is one the core's own window evicted, and appending it would put it back at the wrong end.
 *
 * A plain map rather than a `Ref` for `agentSlot`'s reason (`./session.ts`): every read and write
 * of it is synchronous, which on one JS thread is the atomicity a `Ref` would buy.
 */

import {Effect, type Scope} from "effect";
import {ProcessSelf} from "../../process/self.ts";
import {type AiAgentSessionState, foldEvent, type WindowLimits} from "../core/index.ts";

export interface TranscriptProjection {
	/**
	 * Put this process's projection on `state`, carry over the transcript tail it already holds past
	 * that state, and answer what stands after — which is the state to publish from.
	 */
	readonly seed: (
		state: AiAgentSessionState,
	) => Effect.Effect<AiAgentSessionState, never, ProcessSelf>;
	/**
	 * Fold `step` over the standing projection and answer what it left, or `null` when this process
	 * has none — which is every process whose events Sub has not opened yet.
	 */
	readonly fold: (
		step: (state: AiAgentSessionState) => AiAgentSessionState,
	) => Effect.Effect<AiAgentSessionState | null, never, ProcessSelf>;
}

/**
 * Replay the standing tail the commit has not caught up to, through the core's own item fold so a
 * backend's user item still joins the local echo it supersedes (`../core/fold.ts`).
 */
const rebase = (
	committed: AiAgentSessionState,
	standing: AiAgentSessionState,
	limits: WindowLimits,
): AiAgentSessionState => {
	const named = new Set(committed.transcript.items.map((item) => item.id));
	let cut = -1;
	standing.transcript.items.forEach((item, index) => {
		if (named.has(item.id)) cut = index;
	});
	return standing.transcript.items
		.slice(cut + 1)
		.reduce((state, item) => foldEvent(state, {kind: "item", item}, limits), committed);
};

export const transcriptProjection = (limits: WindowLimits): TranscriptProjection => {
	const held = new WeakMap<Scope.Scope, AiAgentSessionState>();

	const seed = (
		state: AiAgentSessionState,
	): Effect.Effect<AiAgentSessionState, never, ProcessSelf> =>
		Effect.map(ProcessSelf, (self) => {
			const standing = held.get(self.scope);
			const next = standing === undefined ? state : rebase(state, standing, limits);
			held.set(self.scope, next);
			return next;
		});

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
