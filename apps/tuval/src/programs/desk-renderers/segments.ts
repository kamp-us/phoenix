/**
 * The status segments both programs state, written once.
 *
 * `engine-view` and `ps` each declare a `status` renderer for the middle of the bar (#7500 ruling
 * 5), and two of the segments are the same fact about the same table: how many processes there are,
 * and which one is selected. Two copies would be two plural rules and two spellings of "selected",
 * and the bar would read differently depending on which window happens to be focused.
 *
 * A segment's `id` is stable within one bar so a surface can key a list on it, and its `text` is the
 * whole content — there is no region field and no tone carried here, because the shell owns where
 * the middle goes and how it is painted.
 */

import type {ProcessId} from "../../protocol/ids.ts";
import type {StatusSegment} from "../../shell/desk/renderer.ts";

export const processCountSegment = (count: number): StatusSegment => ({
	id: "processes",
	text: `${count} process${count === 1 ? "" : "es"}`,
});

/** The selection, or nothing at all: an absent segment says "none selected" without a word for it. */
export const selectedSegments = (selected: ProcessId | null): ReadonlyArray<StatusSegment> =>
	selected === null ? [] : [{id: "selected", text: `selected ${selected}`}];
