/**
 * @vitest-environment jsdom
 *
 * The two desk-level regions, rendered: the inspector beside the tiling area and the composed
 * status bar under it. The tier is `unit` — every assertion here could be wrong with a perfectly
 * behaved socket, which is the litmus (`.patterns/effect-testing.md`).
 *
 * The harness runs the real reducer, so the toggle is proven the way a founder reaches it: the Msg
 * through the core, and a key bound to `desk:inspector-toggle` in the grammar the kernel sent. A
 * stubbed reducer would prove the surface agrees with a fake.
 */

import {act, fireEvent, render, screen, within} from "@testing-library/react";
import axe from "axe-core";
import {Duration} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId, type RendererRef} from "../../registry/program.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import type {DeskEmptyReason} from "../desk/index.ts";
import {inspectorRenderer, statusRenderer} from "../desk/index.ts";
import type {PrefixTable} from "../keys/index.ts";
import {CommandName, defaultPrefixTable} from "../keys/index.ts";
import type {AnyWindowHost, WindowId} from "../window/index.ts";
import {empty} from "../window/index.ts";
import {Desk} from "./Desk.tsx";
import type {DeskTables} from "./desk-snapshot.ts";
import {noDeskTables} from "./desk-snapshot.ts";
import {installDomShims} from "./dom.testing.ts";
import {threeWindowDesk} from "./fixtures.ts";
import type {MountResolver} from "./mount.ts";
import {useTestKernel} from "./press.testing.ts";

installDomShims();

const COUNTER = ProgramId.make("counter");
const INSPECTOR_REF: RendererRef = {kind: "host-native", ref: "test/inspector"};
const STATUS_REF: RendererRef = {kind: "host-native", ref: "test/status"};

/**
 * A host over the one field these renderers read. The window contract's streams are never touched
 * here, so standing them up would be a socket this tier does not have.
 */
const hostFor = (windowId: WindowId, processId: string): AnyWindowHost => ({
	windowId,
	processId: ProcessId.make(processId),
	readProcess: undefined as never,
	dispatch: undefined as never,
	view: () => null,
	setView: undefined as never,
});

const boundEverywhere: MountResolver = (windowId, processId) =>
	processId === null
		? empty
		: {
				_tag: "Bound",
				name: null,
				host: hostFor(windowId, processId),
				render: (host) => <p>renderer for {String(host.processId)}</p>,
			};

const inspector = (
	render_: (host: AnyWindowHost) => ReactElement,
	kind: RendererRef["kind"] = "host-native",
) => inspectorRenderer(kind, render_);

/** Every window bound, `process-1` running `counter`, and `counter` declaring both desk renderers. */
const tables = (overrides: Partial<DeskTables> = {}): DeskTables => ({
	kernel: {processes: 2, revision: 7},
	processes: {"process-1": {programId: COUNTER}, "process-3": {programId: COUNTER}},
	programs: {[COUNTER]: {inspector: INSPECTOR_REF, status: STATUS_REF}},
	inspectors: {
		[INSPECTOR_REF.ref]: inspector((host) => <p>inspecting {String(host.processId)}</p>),
	},
	statuses: {
		[STATUS_REF.ref]: statusRenderer("host-native", () => [{id: "lines", text: "12 lines"}]),
	},
	...overrides,
});

/** The grammar a kernel could send: the founder's table with `<c-b> i` bound to the toggle. */
const withInspectorKey: PrefixTable = {
	prefix: defaultPrefixTable.prefix,
	repeatTimeout: Duration.millis(500),
	bindings: [
		...defaultPrefixTable.bindings,
		{sequence: "i", command: CommandName.make("desk:inspector-toggle"), repeatable: false},
	],
};

interface HarnessProps {
	readonly initial: ShellState;
	readonly deskTables?: DeskTables;
	readonly table?: PrefixTable;
	readonly resolveMount?: MountResolver;
	readonly windowTitles?: boolean;
	/** Handed the live `dispatch`, so a test can send the Msg a command row names. */
	readonly onReady?: (dispatch: (msg: ShellMsg) => void) => void;
}

function Harness({
	initial,
	deskTables = tables(),
	table = defaultPrefixTable,
	resolveMount = boundEverywhere,
	windowTitles = false,
	onReady,
}: HarnessProps): ReactElement {
	const kernel = useTestKernel(table, initial);
	onReady?.(kernel.dispatch);
	return (
		<Desk
			state={kernel.state}
			dispatch={kernel.dispatch}
			press={kernel.press}
			resolveMount={resolveMount}
			table={table}
			deskTables={deskTables}
			windowTitles={windowTitles}
		/>
	);
}

const opened = (state: ShellState): ShellState => ({
	...state,
	desk: {...state.desk, inspectorOpen: true},
});

const region = (): HTMLElement | null => screen.queryByRole("region", {name: "Desk inspector"});
const group = (name: string): HTMLElement => screen.getByRole("group", {name});

describe("the desk inspector region", () => {
	it("is not rendered at all while the desk holds it closed", () => {
		render(<Harness initial={threeWindowDesk()} />);
		expect(region()).toBeNull();
	});

	it("opens and closes on desk.inspector.toggle", () => {
		let dispatch: (msg: ShellMsg) => void = () => undefined;
		render(<Harness initial={threeWindowDesk()} onReady={(next) => (dispatch = next)} />);
		expect(region()).toBeNull();

		act(() => dispatch({type: "desk.inspector.toggle"}));
		expect(within(region() as HTMLElement).getByText("inspecting process-1")).toBeTruthy();

		act(() => dispatch({type: "desk.inspector.toggle"}));
		expect(region()).toBeNull();
	});

	it("opens on the key a grammar binds to desk:inspector-toggle", () => {
		render(<Harness initial={threeWindowDesk()} table={withInspectorKey} />);
		expect(region()).toBeNull();

		act(() => {
			fireEvent.keyDown(document, {key: "b", ctrlKey: true, code: "KeyB"});
			fireEvent.keyDown(document, {key: "i", code: "KeyI"});
		});
		expect(region()).not.toBeNull();
	});

	it("carries the focused window's process id, which is where it went from the title (#8721)", () => {
		render(<Harness initial={opened(threeWindowDesk())} windowTitles={true} />);
		expect(within(region() as HTMLElement).getByText("process-1")).toBeTruthy();
	});

	it("carries no id while the desk still names its windows by one", () => {
		render(<Harness initial={opened(threeWindowDesk())} />);
		expect(within(region() as HTMLElement).queryByText("process-1")).toBeNull();
	});

	it("survives a workspace switch with its state exactly as it was (#7500 ruling 4)", () => {
		let dispatch: (msg: ShellMsg) => void = () => undefined;
		render(<Harness initial={opened(threeWindowDesk())} onReady={(next) => (dispatch = next)} />);
		expect(region()).not.toBeNull();

		act(() => dispatch({type: "workspace.create"}));
		act(() => dispatch({type: "workspace.step", direction: "next"}));
		expect(region()).not.toBeNull();
	});

	it("keeps the tiling area when an inspector throws", () => {
		const throwing = tables({
			inspectors: {
				[INSPECTOR_REF.ref]: inspector(() => {
					throw new Error("the inspector fell over");
				}),
			},
		});
		render(<Harness initial={opened(threeWindowDesk())} deskTables={throwing} />);

		expect(screen.getByRole("alert").textContent).toContain("The desk inspector stopped rendering");
		expect(screen.getByRole("alert").textContent).toContain("the inspector fell over");
		// The windows are the point: a program's bad inspector costs the panel and nothing else.
		expect(screen.getAllByRole("region", {name: /^Window /})).toHaveLength(3);
	});
});

/**
 * Each arm of `DeskEmptyReason`, driven to the surface. The list is the type's, so an arm added
 * without a placeholder is a compile error here before it is a hole in the browser.
 */
const emptyCases: ReadonlyArray<readonly [DeskEmptyReason, HarnessProps]> = [
	[
		"no-focused-window",
		{initial: opened({...threeWindowDesk(), activeWorkspace: "workspace-gone"})},
	],
	["window-unbound", {initial: opened(threeWindowDesk("window-2"))}],
	["process-unknown", {initial: opened(threeWindowDesk()), deskTables: tables({processes: {}})}],
	["program-unknown", {initial: opened(threeWindowDesk()), deskTables: tables({programs: {}})}],
	[
		"not-declared",
		{initial: opened(threeWindowDesk()), deskTables: tables({programs: {[COUNTER]: {}}})},
	],
	["unknown-ref", {initial: opened(threeWindowDesk()), deskTables: tables({inspectors: {}})}],
	[
		"kind-mismatch",
		{
			initial: opened(threeWindowDesk()),
			deskTables: tables({
				inspectors: {
					[INSPECTOR_REF.ref]: inspector(() => <p>wrong kind</p>, "isolated-frame"),
				},
			}),
		},
	],
];

describe("every reason the inspector has nothing to show", () => {
	for (const [reason, props] of emptyCases) {
		it(`renders a placeholder for ${reason}`, () => {
			render(<Harness {...props} />);
			const panel = region();
			expect(panel).not.toBeNull();
			expect(within(panel as HTMLElement).getByText("Nothing to inspect")).toBeTruthy();
			// A placeholder, not a hole: the reason is spelled out for the reader.
			expect((panel as HTMLElement).textContent?.length ?? 0).toBeGreaterThan(
				"Nothing to inspect".length,
			);
		});
	}
});

describe("the composed status bar", () => {
	it("puts the shell's own facts left and right and the program's segments in the middle", () => {
		render(<Harness initial={threeWindowDesk()} />);
		expect(group("Workspace").textContent).toContain("workspace-0");
		expect(group("Shell").textContent).toContain("2 processes");
		expect(group("Shell").textContent).toContain("rev 7");
		expect(group("Program").textContent).toBe("12 lines");
		// The program reached the middle and nothing else on the bar.
		expect(group("Workspace").textContent).not.toContain("12 lines");
		expect(group("Shell").textContent).not.toContain("12 lines");
	});

	it("renders an empty middle rather than an error when no program filled it", () => {
		render(<Harness initial={threeWindowDesk()} deskTables={noDeskTables} />);
		expect(group("Program").textContent).toBe("");
		expect(group("Workspace").textContent).toContain("workspace-0");
	});

	it("keeps the announcements the line carried before it was composed", () => {
		render(<Harness initial={threeWindowDesk()} />);
		const bar = screen.getByRole("region", {name: "Shell status"});
		expect(bar.textContent).toContain("idle");
		expect(bar.textContent).toContain("Prefix idle.");
		expect(within(bar).getByText(defaultPrefixTable.prefix).tagName).toBe("KBD");

		act(() => {
			fireEvent.keyDown(document, {key: "b", ctrlKey: true, code: "KeyB"});
		});
		expect(bar.textContent).toContain("armed");
		expect(bar.textContent).toContain("Prefix armed, waiting for a sequence.");
	});
});

/**
 * The axe pass runs over the desk with the inspector open, scoped to the two regions this diff
 * builds. Widening it to the whole desk would red this gate on two defects it does not own and
 * cannot fix here — the empty window's picker `listbox` renders no `option` until a program is
 * typed (`aria-required-children`), and `react-resizable-panels` renders its separators outside any
 * landmark (`region`). Both are filed; scoping is the same call `../../claude/window/claude-a11y.unit.test.tsx`
 * makes for the same reason.
 */
describe("axe over the desk with the inspector open", () => {
	it("reports no violations over the inspector region or the status bar", async () => {
		render(<Harness initial={opened(threeWindowDesk())} />);
		const results = await axe.run(
			{include: [[".tuval-inspector"], [".tuval-status"]]},
			{
				// jsdom paints nothing, so axe cannot measure a ratio; the contrast floor is the design
				// layer's, enforced by `@kampus/design`'s own a11y tier.
				rules: {"color-contrast": {enabled: false}},
			},
		);
		expect(results.violations.map((violation) => violation.id)).toEqual([]);
	});
});
