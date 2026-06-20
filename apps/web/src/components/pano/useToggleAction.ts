import {useCallback, useRef} from "react";

/**
 * Serialize-and-supersede driver for an optimistic two-state toggle (#818, #825).
 *
 * The old guard (`if (inFlight) return;`) dropped a second toggle issued while
 * the first mutation was still in flight — but the optimistic write renders
 * "ready" ~260ms before that guard releases, so a rapid on→off silently lost
 * the second intent and the displayed state stuck (vote→unvote lost the
 * retract; save→unsave lost the unsave). The fix keeps the anti-double-submit
 * intent (only ONE mutation runs at a time) without discarding intent: each
 * toggle records the user's latest *desired* end-state; when the in-flight
 * mutation settles, the loop dispatches the corrective mutation if the desired
 * state still differs from what's been achieved. An on→off collapses to a set
 * then an unset (both reach the server); an on→off→on where the middle and
 * final intents cancel collapses to a single set — no same-action double-fire.
 * See `.patterns/fate-mutations-client.md` (concurrent optimistic edits to the
 * same entity are masked) and issues #818 / #825.
 */
export type ToggleAction = "set" | "unset";

/** The mutation pair the loop drives toward the desired on-state. */
export interface ToggleDispatch {
	/** Current on-state at call time, the source of truth the loop reconciles against. */
	readonly on: boolean;
	/** Fire the underlying fate mutation; resolves when it settles (success or rollback). */
	readonly dispatch: (action: ToggleAction) => Promise<void>;
}

/**
 * The corrective action to move from `achieved` toward `desired`, or `null`
 * when they already agree (nothing left to send). Pure — part of the
 * load-bearing race logic, unit-tested without a DOM.
 */
export function nextToggleAction(achieved: boolean, desired: boolean): ToggleAction | null {
	if (achieved === desired) return null;
	return desired ? "set" : "unset";
}

/** What {@link runToggleLoop} reads each turn — supplied by the hook over refs. */
export interface ToggleLoopState {
	/** The user's latest intended end-state; `null` means settled. */
	readonly desired: boolean | null;
	/** Mark the intent satisfied so the loop (and a fresh re-entry) stops. */
	readonly clearDesired: () => void;
	/** Latest committed dispatch surface — re-read so payloads track current props. */
	readonly read: () => ToggleDispatch;
}

/**
 * The serialize-and-supersede loop, extracted hook-free so the race is unit-
 * testable. Dispatches corrective mutations until `achieved` matches `desired`,
 * re-reading `desired` each turn so a toggle issued mid-flight is picked up
 * rather than dropped. `achieved` is seeded from the committed on-state and
 * advanced by each action actually dispatched — the loop never depends on a
 * re-render landing between iterations to observe its own progress. The caller
 * guarantees a single concurrent run.
 */
export async function runToggleLoop(getState: () => ToggleLoopState): Promise<void> {
	let achieved = getState().read().on;
	for (;;) {
		const {desired, clearDesired, read} = getState();
		if (desired === null) return;
		const action = nextToggleAction(achieved, desired);
		if (action === null) {
			clearDesired();
			return;
		}
		await read().dispatch(action);
		achieved = action === "set";
	}
}

/**
 * Returns a `toggle()` that flips the desired on-state and drives the dispatch
 * loop. Only one loop runs at a time (preserving anti-double-submit), and it
 * always converges on the latest desired state — so a toggle-back issued
 * mid-flight is never dropped.
 */
export function useToggleAction(read: () => ToggleDispatch): () => void {
	const readRef = useRef(read);
	readRef.current = read;

	const desiredRef = useRef<boolean | null>(null);
	const runningRef = useRef(false);

	const drive = useCallback(async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		try {
			await runToggleLoop(() => ({
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
		const {on} = readRef.current();
		desiredRef.current = !on;
		void drive();
	}, [drive]);
}
