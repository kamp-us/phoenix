/**
 * Desk state: what the shell holds about the desk itself rather than about one workspace or one
 * window. Two fields today — whether the inspector region is open, and whether the process board's
 * overlay is — and their level is the whole point of the ruling (#7500 ruling 4): each is one
 * surface at the *desk* level, so switching workspaces leaves it exactly as it was. Held per
 * workspace it would flap on every switch; held per window it would flap on every focus move.
 *
 * JSON, like the rest of the shell's state, because the shell checkpoints through the kernel.
 */

/** The desk-level Msgs. They land here, beside the state they write, not in the core's own list. */
export type DeskMsg =
	| {readonly type: "desk.inspector.toggle"}
	| {readonly type: "desk.board.toggle"}
	/**
	 * Closing without asking what the board was. The overlay's own dismissals — Escape, a click
	 * outside, a tile opening a window — all fire from a board that is already open, and a toggle
	 * sent from there would re-open it on any dismissal the chord raced (#8867).
	 */
	| {readonly type: "desk.board.close"};

import {Predicate} from "effect";

export interface DeskState {
	readonly inspectorOpen: boolean;
	/** The process board's overlay. Closed on a fresh desk: it is pulled up by `<c-b> p` (#8867). */
	readonly boardOpen: boolean;
}

/** A fresh desk: both surfaces collapsed, because a first paint with nothing selected shows nothing. */
export const initialDesk: DeskState = {inspectorOpen: false, boardOpen: false};

export const isDeskState = (value: unknown): value is DeskState =>
	Predicate.isObject(value) &&
	typeof value.inspectorOpen === "boolean" &&
	typeof value.boardOpen === "boolean";

/** The whole reducer piece behind `desk.inspector.toggle`. */
export const toggleInspector = (desk: DeskState): DeskState => ({
	...desk,
	inspectorOpen: !desk.inspectorOpen,
});

/** The whole reducer piece behind `desk.board.toggle`. */
export const toggleBoard = (desk: DeskState): DeskState => ({...desk, boardOpen: !desk.boardOpen});

/** The whole reducer piece behind `desk.board.close`. */
export const closeBoard = (desk: DeskState): DeskState => ({...desk, boardOpen: false});
