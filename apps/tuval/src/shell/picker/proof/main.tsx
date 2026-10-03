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
 *
 * The next three panes are #9694's: four harnesses in ten open projects, which is forty session
 * entries, one group per project. One pane is the list as `<c-b> w` leaves it after two Page Downs,
 * one is the same list narrowed to one harness across every project, and one is a desk with nothing
 * open, where each harness is offered once for home. The entries are built by the picker's own
 * `offerEntries` over labels `projectLabels` would give these folders — written out, because that
 * module reads Node's path separator and this is a browser page.
 *
 * The eight panes after those are #9697's "Open project…", answered by a fixture kernel
 * (`./open-project-fixtures.ts`): the program list ending on the new row with the highlight on it,
 * the recent projects with two already open, a desk that has opened nothing yet, the folder browser,
 * the browser narrowed by its filter, the recent list narrowed to one project and the browser
 * narrowed to nothing (#9981), and the refusal a failed open leaves in the step. Each step is
 * reached the way the desk reaches it, through the window's view slot, so the pane reads its rows off
 * the fixture exactly as the page reads them off the kernel.
 *
 * Three panes are #9985's: the program list under a filter that leaves only programs, only
 * running processes, and nothing, where no group says it is empty and the status line says it once.
 *
 * The last pane is #9987's: two open projects that share a folder name, whose program and process
 * ids carry the path key their state is stored under. The rows read each id under its project's
 * label instead, and the global row beside them keeps its bare id.
 */

import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {empty, type ViewState, WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {StrictMode, useState} from "react";
import {createRoot} from "react-dom/client";
import {ProjectLabels} from "../../../projects/labels.ts";
import type {ShellMsg} from "../../core/index.ts";
import {WindowView} from "../../ui/WindowView.tsx";
import {
	browseStep,
	LAST_ROW,
	mountPicker,
	type OfferedProgram,
	offerEntries,
	type PickerEntries,
	type PickerView as PickerViewState,
	type ProjectOpener,
	processPlanned,
	projectNotOpened,
	RECENT_STEP,
	removeFailed,
	withFilter,
	withRefusal,
} from "../browser.ts";
import {CODE_FOLDER, fixtureOpener, RECENT_PROJECTS} from "./open-project-fixtures.ts";
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

/** The four harness rows the repo's global layer registers, as the catalog frame carries them. */
const HARNESSES: ReadonlyArray<OfferedProgram> = [
	{programId: ProgramId.make("pi-session"), label: "Pi", folderAtStart: true},
	{programId: ProgramId.make("claude-session"), label: "Claude", folderAtStart: true},
	{programId: ProgramId.make("agy-session"), label: "agy", folderAtStart: true},
	{programId: ProgramId.make("codex-session"), label: "codex", folderAtStart: true},
];

/** Two rows that keep their own folder: the list they sit under is the one after the sessions. */
const PLAIN: ReadonlyArray<OfferedProgram> = [
	{programId: ProgramId.make("ai-agent-sessions"), label: "Sessions", folderAtStart: false},
	{programId: ProgramId.make("module-counter"), label: "Module counter", folderAtStart: false},
];

/**
 * Ten open projects. The two phoenix checkouts clash on their folder name, so they carry a parent
 * folder each, the way their tiles do.
 */
const OPEN_PROJECTS = [
	"kamp-us/phoenix",
	"usirin/phoenix",
	"demlik",
	"tea",
	"sozluk",
	"pano",
	"atolye",
	"gecit",
	"fabrika",
	"notes",
].map((label, index) => ({key: `-code-project-${index}`, label}));

const sessionEntries: PickerEntries = {
	programs: offerEntries([...HARNESSES, ...PLAIN], OPEN_PROJECTS),
	processes: [process("p-claude-phoenix", "claude-session", "claude-session")],
};

const homeEntries: PickerEntries = {
	programs: offerEntries([...HARNESSES, ...PLAIN], []),
	processes: [],
};

/** Two Page Downs from the top: the first row of the third project's group. */
const onThirdProject: PickerViewState = {...mountPicker(), cursor: HARNESSES.length * 2};

/** Two projects open, so the picker offers each harness in both beside "Open project…". */
const twoOpen: PickerEntries = {
	programs: offerEntries(HARNESSES, [
		{key: "-Users-ada-code-kamp-us-phoenix", label: "phoenix"},
		{key: "-Users-ada-notes", label: "notes"},
	]),
	processes: [],
};

/**
 * A process whose program the picker no longer offers, so a query can match it and no program:
 * the one-sided filter #9985 drops the emptied Programs group for.
 */
const orphanedProcess: PickerEntries = {
	programs: entries.programs.slice(0, 2),
	processes: [process("p-log", "demo/log", "Log viewer")],
};

/**
 * Two open projects whose folders share a name (#9987), keyed the way ADR 0402 keys their state
 * directories. Their ids carry that path key; the picker shows each project's label in its place.
 */
const PHOENIX_KAMP_US = "-Users-ada-code-github.com-kamp_-us-phoenix";
const PHOENIX_USIRIN = "-Users-ada-code-github.com-usirin-phoenix";
const clashingProjects = ProjectLabels.of([
	{key: PHOENIX_KAMP_US, label: "kamp-us/phoenix"},
	{key: PHOENIX_USIRIN, label: "usirin/phoenix"},
]);

/**
 * A running process as the page lists it (`../../../page/AttachedDesk.tsx`): named by its program
 * id, read under the program's project label.
 */
const scopedProcess = (id: string, programId: string, parent?: string) =>
	process(id, programId, clashingProjects.displayId(programId), parent);

/** Program and process rows from both projects beside one global row, which keeps its bare id. */
const scopedEntries: PickerEntries = {
	programs: [
		program(`${PHOENIX_KAMP_US}/counter`, "counter"),
		program(`${PHOENIX_USIRIN}/counter`, "counter"),
		program("module-counter", "Module counter"),
	],
	processes: [
		scopedProcess(`${PHOENIX_KAMP_US}/log`, `${PHOENIX_KAMP_US}/log`),
		scopedProcess(
			`${PHOENIX_KAMP_US}/7f3a9c2e-1b4d-4e8a-9c61-2d5f0e8b7a14`,
			`${PHOENIX_KAMP_US}/counter`,
			`${PHOENIX_KAMP_US}/log`,
		),
		scopedProcess(`${PHOENIX_USIRIN}/counter`, `${PHOENIX_USIRIN}/counter`),
		scopedProcess("p-module-counter", "module-counter"),
	],
};

const withRecent = fixtureOpener(RECENT_PROJECTS);
const withNoRecent = fixtureOpener([]);

const onRecent: PickerViewState = {...mountPicker(), step: RECENT_STEP};
const inCode: PickerViewState = {...mountPicker(), step: browseStep(CODE_FOLDER)};

function Pane({
	name,
	start,
	focused,
	processRemove = false,
	offered = entries,
	opener = null,
	projects = ProjectLabels.none,
}: {
	readonly name: string;
	readonly start: PickerViewState;
	readonly focused: boolean;
	/** The operator's `processRemove` flag, passed through `WindowView` exactly as the desk passes it. */
	readonly processRemove?: boolean;
	/** What the picker offers; the first five panes share one small list. */
	readonly offered?: PickerEntries;
	/** The fixture kernel "Open project…" asks; absent, the pane offers no such row. */
	readonly opener?: ProjectOpener | null;
	/** The open projects' labels, as the projects frame hands them to the desk. */
	readonly projects?: ProjectLabels;
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
				entries={offered}
				dispatch={(msg: ShellMsg) => {
					if (msg.type === "window.setView") setView(msg.view);
					else globalThis.console.log(msg.type);
				}}
				reducedMotion={false}
				processRemove={processRemove}
				opener={opener}
				projects={projects}
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
			{/* #9694, three panes: forty session entries grouped by project with the highlight two
			    groups down, the same list narrowed to one harness, and the home list. */}
			<Pane
				name="picker-sessions"
				start={onThirdProject}
				focused={false}
				offered={sessionEntries}
			/>
			<Pane
				name="picker-sessions-filtered"
				start={withFilter(mountPicker(), "claude")}
				focused={false}
				offered={sessionEntries}
			/>
			<Pane
				name="picker-sessions-home"
				start={mountPicker()}
				focused={false}
				offered={homeEntries}
			/>
			{/* #9697, eight panes: the row, both steps, the empty recent list, a narrowed browser, a
			    narrowed recent list and a browser narrowed to nothing (#9981), and an open's refusal. */}
			<Pane
				name="picker-open-project-row"
				start={{...mountPicker(), cursor: LAST_ROW}}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			<Pane
				name="picker-open-project-recent"
				start={onRecent}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			<Pane
				name="picker-open-project-none"
				start={onRecent}
				focused={false}
				offered={homeEntries}
				opener={withNoRecent}
			/>
			<Pane
				name="picker-open-project-browse"
				start={{...inCode, cursor: 3}}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			<Pane
				name="picker-open-project-browse-filtered"
				start={withFilter(inCode, "so")}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			<Pane
				name="picker-open-project-recent-filtered"
				start={withFilter(onRecent, "dem")}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			<Pane
				name="picker-open-project-browse-unmatched"
				start={withFilter(inCode, "zzz")}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			<Pane
				name="picker-open-project-refused"
				start={withRefusal(
					{...onRecent, cursor: 1},
					projectNotOpened(
						"/Users/ada/code/kamp-us/demlik",
						"it is not trusted, so nothing from it ran",
					),
				)}
				focused={false}
				offered={twoOpen}
				opener={withRecent}
			/>
			{/* #9985, three panes: the program list under a filter that matches only a program, only a
			    running process, and nothing. A group the filter emptied is dropped, not labelled. */}
			<Pane
				name="picker-filtered-programs-only"
				start={withFilter(mountPicker(), "clock")}
				focused={false}
			/>
			<Pane
				name="picker-filtered-processes-only"
				start={withFilter(mountPicker(), "log")}
				focused={false}
				offered={orphanedProcess}
			/>
			<Pane
				name="picker-filtered-unmatched"
				start={withFilter(mountPicker(), "zzz")}
				focused={false}
			/>
			{/* #9987: the rows of two projects that share a folder name, each read by its label. */}
			<Pane
				name="picker-scoped-ids"
				start={mountPicker()}
				focused={false}
				offered={scopedEntries}
				projects={clashingProjects}
			/>
		</div>
	</StrictMode>,
);
