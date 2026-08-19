/**
 * The pure decision core for deterministic live read-back — the bounded fallback for a
 * `appendNode` push the mutator's own view can lose to the subscribe race (#714). See
 * `.patterns/fate-live-views.md` ("Deterministic read-back").
 */

export interface ReadbackState {
	/** Expected to *appear* after a create ({@link decideReadback}), to *leave* after a
	 *  delete ({@link decideConfirmGone}). */
	readonly expectedId: string;
	readonly probesRemaining: number;
}

export type ReadbackDecision =
	| {readonly action: "settled"}
	| {readonly action: "wait"; readonly next: ReadbackState}
	| {readonly action: "refetch"};

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

/**
 * The delete-direction twin of {@link decideReadback}. A soft delete counts as gone
 * because the caller passes the *visible* set, not the raw ids (#1687).
 */
export function decideConfirmGone(
	presentIds: ReadonlySet<string>,
	state: ReadbackState,
): ReadbackDecision {
	if (!presentIds.has(state.expectedId)) return {action: "settled"};
	if (state.probesRemaining <= 0) return {action: "refetch"};
	return {
		action: "wait",
		next: {expectedId: state.expectedId, probesRemaining: state.probesRemaining - 1},
	};
}

export const DEFAULT_READBACK_PROBES = 3;
