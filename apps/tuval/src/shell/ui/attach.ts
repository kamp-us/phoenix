/**
 * The page's attachment, as a state machine over four events and a hook that drives it.
 *
 * A drop is not repaired: attaching again is the repair, and the server replays current state
 * rather than a transcript (`../transport/client.ts`). What that leaves the page owing is this
 * file's one rule — **a drop never clears the desk**. The last snapshot stays on screen while the
 * socket is re-opened, so a re-attach is a refresh and not a blank page. The desk is the kernel's
 * either way, so nothing here can be stale in a way the next snapshot does not fix.
 *
 * The machine is pure and takes no socket, so the whole lifecycle is testable without one. The
 * transport is the `DeskSource` a caller supplies: subscribe, emit events, hand back an unsubscribe.
 */

import {useEffect, useState} from "react";
import {isShellState, type ShellState} from "../core/index.ts";

export type AttachEvent =
	| {readonly _tag: "Attached"}
	/** One snapshot of the shell process's state, straight off the wire and still `unknown`. */
	| {readonly _tag: "Snapshot"; readonly state: unknown}
	| {readonly _tag: "Dropped"; readonly reason: string};

export type AttachStatus = "connecting" | "attached" | "reattaching";

export interface AttachState {
	readonly status: AttachStatus;
	/** The last desk the kernel sent. Kept across a drop; `null` only before the first snapshot. */
	readonly desk: ShellState | null;
	/** How many times this page has attached, first attach included. */
	readonly attachments: number;
	readonly lastDrop: string | null;
	/**
	 * A snapshot the shell's own guard refused. Counted rather than thrown: the socket is fine and
	 * the next snapshot may be sound, so a page that dropped the connection over one would be
	 * repairing the wrong thing.
	 */
	readonly refusedSnapshots: number;
}

export const attachInitial: AttachState = {
	status: "connecting",
	desk: null,
	attachments: 0,
	lastDrop: null,
	refusedSnapshots: 0,
};

export const onAttachEvent = (state: AttachState, event: AttachEvent): AttachState => {
	switch (event._tag) {
		case "Attached":
			return {...state, status: "attached", attachments: state.attachments + 1};
		case "Snapshot":
			return isShellState(event.state)
				? {...state, status: "attached", desk: event.state}
				: {...state, refusedSnapshots: state.refusedSnapshots + 1};
		case "Dropped":
			return {...state, status: "reattaching", lastDrop: event.reason};
	}
};

/** Where events come from. One call, one subscription; the returned function ends it. */
export type DeskSource = (emit: (event: AttachEvent) => void) => () => void;

/**
 * Attach on mount, re-attach on drop, and keep the desk across the gap. The source owns the
 * reconnect — it is the thing that holds the socket — and this only folds what it reports.
 */
export const useDeskAttachment = (source: DeskSource): AttachState => {
	const [state, setState] = useState<AttachState>(attachInitial);

	useEffect(() => {
		let live = true;
		const stop = source((event) => {
			if (!live) return;
			setState((current) => onAttachEvent(current, event));
		});
		return () => {
			live = false;
			stop();
		};
	}, [source]);

	return state;
};
