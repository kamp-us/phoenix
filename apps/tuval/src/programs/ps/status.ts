/**
 * `ps`'s status renderer: what this program puts in the middle of the desk's status bar while one of
 * its windows is focused (#7500 ruling 5).
 *
 * Three segments and no more — the process count, the order the table is in, and the selection —
 * because the left and the right are the shell's and a program has no vocabulary to ask for either
 * (`../../shell/desk/renderer.ts`). The order segment reads the column's own header out of
 * `./columns.ts` rather than spelling the name again, so the bar and the `<th>` can never disagree
 * about what the table is sorted by.
 *
 * **Why the renderer is minted from facts rather than reading them off its host.** `segments` is
 * synchronous and a `WindowHost` carries one process, asynchronously (`readProcess` is a stream), so
 * neither the table nor this program's committed state can be read there. The shell assembles the
 * `statuses` table for each `DeskSnapshot` it composes, so the facts are bound at that point — which
 * leaves this a pure function of the Snapshot plus the program's own state, and leaves nothing here
 * to fetch.
 */

import type {ProcessRow} from "../../protocol/process-row.ts";
import type {StatusRenderer, StatusSegment} from "../../shell/desk/renderer.ts";
import {statusRenderer} from "../../shell/desk/renderer.ts";
import type {ViewState} from "../../shell/window/host.ts";
import {processCountSegment, selectedSegments} from "../desk-renderers/segments.ts";
import {psColumn} from "./columns.ts";
import type {PsMsg, PsState} from "./state.ts";

/** What the segments are derived from: the Snapshot's rows, and this program's committed state. */
export interface PsStatusFacts {
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly state: PsState;
}

/** The forest walk has no column, so it is named rather than spelled as a column that is not sorted. */
const orderSegment = (state: PsState): StatusSegment => ({
	id: "order",
	text:
		state.sortColumn === null
			? "default order"
			: `sorted by ${psColumn(state.sortColumn).header}, ${state.sortDirection}`,
});

export const psStatusSegments = (facts: PsStatusFacts): ReadonlyArray<StatusSegment> => [
	processCountSegment(facts.processes.length),
	orderSegment(facts.state),
	...selectedSegments(facts.state.selectedProcessId),
];

export const psStatusRenderer = (facts: PsStatusFacts): StatusRenderer<PsState, PsMsg, ViewState> =>
	statusRenderer<PsState, PsMsg, ViewState>("host-native", () => psStatusSegments(facts));
