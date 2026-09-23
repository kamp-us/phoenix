/**
 * The window picker in a real browser, with its `/` filter open — no kernel, no socket, no registry.
 *
 * On the real desk the picker is two gestures deep (`<c-b> w`, then `/`) and `fabrika ui render`
 * drives a bare route, so without this page the design gate cannot reach the state it is asked to
 * judge: PR #8914's `ship gate` refused at head with `review-ui absent` for exactly that reason.
 * The page mounts the two states side by side instead — the picker as `<c-b> w` leaves it, and the
 * same picker with a query already typed — through the real `WindowView` on its real `Empty` arm,
 * so what is captured is the window chrome the operator sees and not a bare list.
 *
 * The filter's behaviour is the unit tier's (`../view.unit.test.ts`,
 * `../../ui/picker-filter.unit.test.tsx`); what only a browser can settle is paint: the filter row's
 * box against the command line's, where the narrowed sections sit, and that the two status regions
 * take no room. Every pane stays live, so `/`, `j`, `k`, `d` and Escape all work if you drive it by
 * hand with `pnpm proof:picker` from `apps/tuval`.
 *
 * Three panes were added for #9447's removal affordance, for the same reason the first two exist:
 * `review-ui` parked that PR `CANT-SEE` because the flag-on picker and its two new refusals render at
 * no route the gate can reach. So the page routes them — the `processRemove` flag on with the
 * highlight on a removable row, which is the only state that paints the `d` key-help row, and the two
 * refusals in the window's own assertive region. The refusals are built with the shipped
 * constructors rather than written out as literals, so a pane cannot drift from the arm it claims to
 * show.
 *
 * The first pane keeps the flag off on purpose: the help row's absence is the containment #9447
 * states, and an on/off pair at one viewport is what makes that falsifiable by eye.
 */

import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {empty, type ViewState, WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {StrictMode, useState} from "react";
import {createRoot} from "react-dom/client";
import type {ShellMsg} from "../../core/index.ts";
import {WindowView} from "../../ui/WindowView.tsx";
import {
	mountPicker,
	type PickerEntries,
	type PickerView as PickerViewState,
	processPlanned,
	removeFailed,
	withFilter,
	withRefusal,
} from "../browser.ts";
import "../../../page/styles.ts";
import "./proof.css";

const program = (id: string, label: string) => ({
	_tag: "Program" as const,
	programId: ProgramId.make(id),
	label,
});

const process = (id: string, programId: string, label: string, parent?: string) => ({
	_tag: "Process" as const,
	processId: ProcessId.make(id),
	programId: ProgramId.make(programId),
	label,
	parentId: parent === undefined ? null : ProcessId.make(parent),
});

/**
 * Enough rows that both sections narrow under one query and neither empties: `co` leaves Counter and
 * Clock among the programs and the counter process among the running ones. A query that emptied a
 * section would capture the no-match line instead, which is a different state and has its own
 * assertions in the unit tier.
 */
const entries: PickerEntries = {
	programs: [
		program("demo/counter", "Counter"),
		program("demo/clock", "Clock"),
		program("demo/log", "Log viewer"),
		program("ai/claude", "Claude"),
		program("ai/pi", "Pi chat"),
	],
	processes: [
		process("p-counter", "demo/counter", "Counter"),
		process("p-claude", "ai/claude", "Claude"),
		process("p-log", "demo/log", "Log viewer", "p-claude"),
	],
};

const QUERY = "co";

/**
 * The first running-process row. `flatten` puts the programs first, so this is the index a `j`-walk
 * reaches the first removable row at — and `d` is live only on a process row, so it is the only
 * highlight that makes the affordance legible.
 */
const FIRST_PROCESS = entries.programs.length;

/** The row every removal pane names, so the highlight and the refusal below it agree. */
const REMOVABLE = entries.processes[0];
if (REMOVABLE === undefined) throw new Error("the proof page offers no process to remove");

const onRemovableRow: PickerViewState = {...mountPicker(), cursor: FIRST_PROCESS};

function Pane({
	name,
	start,
	focused,
	processRemove = false,
}: {
	readonly name: string;
	readonly start: PickerViewState;
	readonly focused: boolean;
	/** The operator's `processRemove` flag, passed through `WindowView` exactly as the desk passes it. */
	readonly processRemove?: boolean;
}) {
	// The slot the desk would hold, at the desk's own type: `WindowView` reads it back through the
	// real `asPickerView`, so the page proves the round trip rather than a narrowed object.
	const [view, setView] = useState<ViewState>({...start});
	const windowId = WindowId.make(name);
	return (
		<div className="proof-pane">
			<WindowView
				windowId={windowId}
				mount={empty}
				focused={focused}
				view={view}
				entries={entries}
				dispatch={(msg: ShellMsg) => {
					if (msg.type === "window.setView") setView(msg.view);
					else globalThis.console.log(msg.type);
				}}
				reducedMotion={false}
				processRemove={processRemove}
			/>
		</div>
	);
}

const host = document.getElementById("proof");
if (host === null) throw new Error("the proof page has no #proof element");

// A request that outlives the announce pause, so a capture taken at network-idle has the match count
// on the page rather than two empty status regions (`./vite.config.ts`). It changes nothing the page
// renders; only when a capture is allowed to be taken.
// The body is read rather than dropped: an unread response stream leaves the request in flight as
// far as the browser is concerned, and network-idle then never arrives at all.
void fetch("/announce-pause")
	.then((response) => response.text())
	.catch(() => {});

createRoot(host).render(
	<StrictMode>
		<div className="tuval-surface proof-desk" data-scheme="dark">
			{/* The unfocused pane, because only one element on a page holds the caret and the filtering
			    one has to be the one that holds it. */}
			<Pane name="picker-open" start={mountPicker()} focused={false} />
			<Pane name="picker-filtering" start={withFilter(mountPicker(), QUERY)} focused={true} />
			{/* #9447, three panes. The first is the flag on and nothing refused: the only difference
			    from `picker-open` is the `d` row in the key help, which is the containment stated as
			    paint. The other two are the refusals, each in the window's assertive region, where a
			    long sentence wrapping against the list is the thing jsdom cannot settle. */}
			<Pane name="picker-removable" start={onRemovableRow} focused={false} processRemove={true} />
			<Pane
				name="picker-refused-planned"
				start={withRefusal(onRemovableRow, processPlanned(REMOVABLE.processId))}
				focused={false}
				processRemove={true}
			/>
			<Pane
				name="picker-refused-forget"
				start={withRefusal(
					onRemovableRow,
					removeFailed(REMOVABLE.processId, "checkpoint manifest refused: not a manifest"),
				)}
				focused={false}
				processRemove={true}
			/>
		</div>
	</StrictMode>,
);
