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
 * take no room. Both panes stay live, so `/`, `j`, `k` and Escape all work if you drive it by hand
 * with `pnpm proof:picker` from `apps/tuval`.
 */

import {StrictMode, useState} from "react";
import {createRoot} from "react-dom/client";
import {ProcessId} from "../../../process/process.ts";
import {ProgramId} from "../../../registry/program.ts";
import type {ShellMsg} from "../../core/index.ts";
import {WindowView} from "../../ui/WindowView.tsx";
import {empty, type ViewState, WindowId} from "../../window/index.ts";
import {
	mountPicker,
	type PickerEntries,
	type PickerView as PickerViewState,
	withFilter,
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

function Pane({
	name,
	start,
	focused,
}: {
	readonly name: string;
	readonly start: PickerViewState;
	readonly focused: boolean;
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
		</div>
	</StrictMode>,
);
