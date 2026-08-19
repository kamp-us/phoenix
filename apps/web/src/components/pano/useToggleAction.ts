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

export interface ToggleDispatch {
	readonly on: boolean;
	/** Resolves when the mutation settles — success or rollback. */
	readonly dispatch: (action: ToggleAction) => Promise<void>;
}

export function nextToggleAction(achieved: boolean, desired: boolean): ToggleAction | null {
	if (achieved === desired) return null;
	return desired ? "set" : "unset";
}

export interface ToggleLoopState {
	/** `null` means settled — the loop and a fresh re-entry both stop on it. */
	readonly desired: boolean | null;
	readonly clearDesired: () => void;
	/** Re-read each turn so payloads track current props. */
	readonly read: () => ToggleDispatch;
}

/**
 * `achieved` is advanced by each dispatched action, never re-read from props: the
 * loop must not depend on a re-render landing between iterations. Caller
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
