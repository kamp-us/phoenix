/**
 * Which "Open project…" step a picker window is on (#9697), as its view slot stores it. Split from
 * `./open-project.ts` so `./view.ts` can read a slot back without importing the step's rows and
 * frame, which import `./view.ts` themselves.
 */

import {Predicate} from "effect";

/**
 * Which step the picker is on. `Browse` names the folder it shows, or `null` for the desk's home
 * folder, which the page does not know the path of until the kernel answers.
 */
export type OpenProjectStep =
	| {readonly _tag: "Recent"}
	| {readonly _tag: "Browse"; readonly folder: string | null};

export const RECENT_STEP: OpenProjectStep = {_tag: "Recent"};

export const browseStep = (folder: string | null): OpenProjectStep => ({_tag: "Browse", folder});

/** A step read back out of a view slot any program may have written, or `null`. */
export const asOpenProjectStep = (value: unknown): OpenProjectStep | null => {
	if (!Predicate.isObject(value)) return null;
	if (value._tag === "Recent") return RECENT_STEP;
	if (value._tag === "Browse" && (value.folder === null || typeof value.folder === "string")) {
		return browseStep(value.folder);
	}
	return null;
};

/**
 * Where a cursor that means "the last row" is written. The Recent step always ends on "Browse for a
 * folder…" and the program list always ends on "Open project…", so Escape lands back on the row it
 * left from without knowing how many rows came before it: every read clamps the cursor into the list.
 */
export const LAST_ROW = Number.MAX_SAFE_INTEGER;
