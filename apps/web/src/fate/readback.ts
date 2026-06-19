/**
 * Deterministic live read-back — the decision core.
 *
 * A create-mutation's own connection view (a comment thread, a definition list)
 * is driven live by the server's `appendNode` push. That push can be *lost*: the
 * fire-and-forget publish fans out to the topic DO before the subscriber row has
 * been registered, so it delivers to an empty registry and the event vanishes
 * (#714 diagnosis on epic #713). The mutator's own view then waits on a push that
 * never arrives and the new node never appears until a manual refresh.
 *
 * The fix is a bounded read-back: after the mutator's own create succeeds, watch
 * its connection for the new node id; if the live push lands it, do nothing; if it
 * doesn't within a short grace window, refetch the owning request `network-only`
 * so the node lands deterministically. The live subscription stays intact for
 * other clients — this only makes the *mutator's own* view independent of the race.
 *
 * This module is the pure decision: given which ids the connection currently holds,
 * the id we expect, and how many probes are left, decide whether to keep waiting
 * for the push, fire the fallback refetch, or stop. No React, no client — so the
 * race-handling contract is unit-testable without a DOM. See
 * `.patterns/fate-live-views.md` ("Deterministic read-back").
 */

/** A pending read-back: the node we're waiting on plus the probe budget left. */
export interface ReadbackState {
	/** The created node's id the mutator expects to see in its own connection. */
	readonly expectedId: string;
	/** Probes left before we stop waiting (each probe is one grace tick). */
	readonly probesRemaining: number;
}

export type ReadbackDecision =
	/** The node is present (the live push won, or the refetch already landed it) — stop. */
	| {readonly action: "settled"}
	/** The node isn't present and probes remain — wait one grace tick for the push. */
	| {readonly action: "wait"; readonly next: ReadbackState}
	/** The node isn't present and the budget is spent — fire the fallback refetch, then stop. */
	| {readonly action: "refetch"};

/**
 * Decide the next read-back step. `presentIds` is the set of node ids the
 * connection currently holds (read off the live items). Settles the instant the
 * expected id appears (live push won → no refetch), waits while probes remain, and
 * refetches deterministically on the final probe.
 */
export function decideReadback(
	presentIds: ReadonlySet<string>,
	state: ReadbackState,
): ReadbackDecision {
	if (presentIds.has(state.expectedId)) return {action: "settled"};
	if (state.probesRemaining <= 0) return {action: "refetch"};
	return {
		action: "wait",
		next: {expectedId: state.expectedId, probesRemaining: state.probesRemaining - 1},
	};
}

/** Default probe budget — short grace window for the live push before falling back. */
export const DEFAULT_READBACK_PROBES = 3;
