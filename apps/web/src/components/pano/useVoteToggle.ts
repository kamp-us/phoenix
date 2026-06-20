import {useCallback, useRef} from "react";

/**
 * Serialize-and-supersede driver for an optimistic vote toggle (#818).
 *
 * The old guard (`if (inFlight) return;`) dropped a second toggle issued while
 * the first mutation was still in flight — but the optimistic write renders
 * "ready" ~260ms before that guard releases, so a rapid vote→unvote silently
 * lost the retract and the score stuck. The fix keeps the anti-double-submit
 * intent (only ONE mutation runs at a time) without discarding intent: each
 * toggle records the user's latest *desired* end-state; when the in-flight
 * mutation settles, the loop dispatches the corrective mutation if the desired
 * state still differs from what's been achieved. A vote→unvote collapses to a
 * vote then a retract (both reach the server); a vote→unvote→vote where the
 * middle and final intents cancel collapses to a single vote — no same-action
 * double-fire. See `.patterns/fate-mutations-client.md` (concurrent optimistic
 * edits to the same entity are masked) and issue #818.
 */
export type VoteAction = "vote" | "retract";

/** The mutation pair the loop drives toward the desired voted-state. */
export interface VoteToggleDispatch {
	/** Current voted-state at call time, the source of truth the loop reconciles against. */
	readonly voted: boolean;
	/** Fire the underlying fate mutation; resolves when it settles (success or rollback). */
	readonly dispatch: (action: VoteAction) => Promise<void>;
}

/**
 * The corrective action to move from `achieved` toward `desired`, or `null`
 * when they already agree (nothing left to send). Pure — part of the
 * load-bearing race logic, unit-tested without a DOM.
 */
export function nextVoteAction(achieved: boolean, desired: boolean): VoteAction | null {
	if (achieved === desired) return null;
	return desired ? "vote" : "retract";
}

/** What {@link runVoteLoop} reads each turn — supplied by the hook over refs. */
export interface VoteLoopState {
	/** The user's latest intended end-state; `null` means settled. */
	readonly desired: boolean | null;
	/** Mark the intent satisfied so the loop (and a fresh re-entry) stops. */
	readonly clearDesired: () => void;
	/** Latest committed dispatch surface — re-read so payloads track current props. */
	readonly read: () => VoteToggleDispatch;
}

/**
 * The serialize-and-supersede loop, extracted hook-free so the race is unit-
 * testable. Dispatches corrective mutations until `achieved` matches `desired`,
 * re-reading `desired` each turn so a toggle issued mid-flight is picked up
 * rather than dropped. `achieved` is seeded from the committed voted-state and
 * advanced by each action actually dispatched — the loop never depends on a
 * re-render landing between iterations to observe its own progress. The caller
 * guarantees a single concurrent run.
 */
export async function runVoteLoop(getState: () => VoteLoopState): Promise<void> {
	let achieved = getState().read().voted;
	for (;;) {
		const {desired, clearDesired, read} = getState();
		if (desired === null) return;
		const action = nextVoteAction(achieved, desired);
		if (action === null) {
			clearDesired();
			return;
		}
		await read().dispatch(action);
		achieved = action === "vote";
	}
}

/**
 * Returns a `toggle()` that flips the desired voted-state and drives the
 * dispatch loop. Only one loop runs at a time (preserving anti-double-submit),
 * and it always converges on the latest desired state — so a toggle-back issued
 * mid-flight is never dropped.
 */
export function useVoteToggle(read: () => VoteToggleDispatch): () => void {
	const readRef = useRef(read);
	readRef.current = read;

	const desiredRef = useRef<boolean | null>(null);
	const runningRef = useRef(false);

	const drive = useCallback(async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		try {
			await runVoteLoop(() => ({
				desired: desiredRef.current,
				clearDesired: () => {
					desiredRef.current = null;
				},
				read: () => readRef.current(),
			}));
		} finally {
			runningRef.current = false;
		}
	}, []);

	return useCallback(() => {
		const {voted} = readRef.current();
		desiredRef.current = !voted;
		void drive();
	}, [drive]);
}
