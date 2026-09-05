/**
 * Desk state: what the shell holds about the desk itself rather than about one workspace or one
 * window. Today that is one field — whether the inspector region is open — and its level is the
 * whole point of the ruling (#7500 ruling 4): the inspector is one region beside the tiling area at
 * the *desk* level, so switching workspaces leaves it exactly as it was. Held per workspace it
 * would flap on every switch; held per window it would flap on every focus move.
 *
 * JSON, like the rest of the shell's state, because the shell checkpoints through the kernel.
 */

/** One desk-level Msg today. It lands here, beside the state it writes, not in the core's own list. */
export type DeskMsg = {readonly type: "desk.inspector.toggle"};

import {Predicate} from "effect";

export interface DeskState {
	readonly inspectorOpen: boolean;
}

/** A fresh desk: the inspector collapsed, because a first paint with nothing selected shows nothing. */
export const initialDesk: DeskState = {inspectorOpen: false};

export const isDeskState = (value: unknown): value is DeskState =>
	Predicate.isObject(value) && typeof value.inspectorOpen === "boolean";

/** The whole reducer piece behind `desk.inspector.toggle`. */
export const toggleInspector = (desk: DeskState): DeskState => ({
	...desk,
	inspectorOpen: !desk.inspectorOpen,
});
