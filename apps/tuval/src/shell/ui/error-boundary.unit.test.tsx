/**
 * @vitest-environment jsdom
 *
 * The boundary, proved through the desk rather than in isolation: what #7839 cost a founder was not
 * "an uncaught error" but a blank tab, so the assertions are about what is still on the page after a
 * window renderer throws.
 */

import {act, fireEvent, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ProcessId} from "../../process/process.ts";
import type {ShellState} from "../core/index.ts";
import {isShellState} from "../core/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {createStack, createTree, createWindow} from "../layout/index.ts";
import {Desk} from "./Desk.tsx";
import {installDomShims} from "./dom.testing.ts";
import {ErrorBoundary} from "./ErrorBoundary.tsx";
import {deskWith} from "./fixtures.ts";
import type {MountResolver} from "./mount.ts";
import {useTestKernel} from "./press.testing.ts";
import {refused} from "./press.ts";

installDomShims();

const THROWN = "the renderer could not read the process";

/** A desk whose every window renderer throws — the shape of a program view that failed. */
const throwingMount =
	(throwing: boolean): MountResolver =>
	(windowId, processId) => ({
		_tag: "Bound",
		host: {
			windowId,
			processId: ProcessId.make(processId ?? "process-1"),
			readProcess: undefined as never,
			dispatch: undefined as never,
			view: () => null,
			setView: undefined as never,
		},
		render: () => {
			if (throwing) throw new Error(THROWN);
			return <p>the window rendered</p>;
		},
	});

const desk = (): ShellState =>
	deskWith(
		createTree(createStack("stack-root", "horizontal", [createWindow("window-1", "process-1")])),
		"window-1",
	);

function DeskHarness({
	initial,
	throwing,
}: {
	readonly initial: ShellState;
	readonly throwing: boolean;
}): ReactElement {
	const kernel = useTestKernel(defaultPrefixTable, initial);
	return (
		<Desk
			state={kernel.state}
			dispatch={kernel.dispatch}
			press={kernel.press}
			resolveMount={throwingMount(throwing)}
			table={defaultPrefixTable}
		/>
	);
}

const statusLine = () => screen.getByRole("region", {name: "Shell status"});

beforeEach(() => {
	// React reports every caught error on `console.error` as well as handing it to the boundary.
	// The report is the runtime's, not the desk's, and these cases throw on purpose.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a window renderer that throws", () => {
	it("does not blank the desk: the status line and the failure's own words are both on the page", () => {
		render(<DeskHarness initial={desk()} throwing />);

		expect(statusLine()).toBeDefined();
		const alert = screen.getByRole("alert");
		// The window's own boundary catches it now, so the panel names the process and not the desk
		// (#8157). The desk-level boundary is still above it, for a throw in the tiling area itself.
		expect(alert.textContent).toContain("Process process-1 stopped rendering.");
		expect(alert.textContent).toContain(THROWN);
		expect(document.body.textContent?.trim()).not.toBe("");
	});

	it("keeps the desk's keyboard alive — the surface below the throw still routes a prefix", () => {
		render(<DeskHarness initial={desk()} throwing />);

		act(() => {
			fireEvent.keyDown(document, {key: "b", ctrlKey: true});
		});

		expect(statusLine().textContent).toContain("armed");
	});
});

/** Two bound windows over two processes, where only the first one's renderer throws (#8157). */
const oneThrowingMount: MountResolver = (windowId, processId) => ({
	_tag: "Bound",
	host: {
		windowId,
		processId: ProcessId.make(processId ?? "process-1"),
		readProcess: undefined as never,
		dispatch: undefined as never,
		view: () => null,
		setView: undefined as never,
	},
	render: () => {
		if (processId === "process-1") throw new Error(THROWN);
		return <p>{`window over ${processId} rendered`}</p>;
	},
});

const twoWindowDesk = (): ShellState =>
	deskWith(
		createTree(
			createStack("stack-root", "horizontal", [
				createWindow("window-1", "process-1"),
				createWindow("window-2", "process-2"),
			]),
		),
		"window-1",
	);

describe("one window's renderer throwing", () => {
	it("costs that window and no other: the sibling is still rendered", () => {
		render(
			<Desk
				state={twoWindowDesk()}
				dispatch={() => {}}
				press={() => Promise.resolve(refused)}
				resolveMount={oneThrowingMount}
				table={defaultPrefixTable}
			/>,
		);

		const alerts = screen.getAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.textContent).toContain("Process process-1 stopped rendering.");
		expect(screen.getByText("window over process-2 rendered")).toBeDefined();
		expect(statusLine()).toBeDefined();
	});

	it("leaves the failed window's own title and frame in place", () => {
		render(
			<Desk
				state={twoWindowDesk()}
				dispatch={() => {}}
				press={() => Promise.resolve(refused)}
				resolveMount={oneThrowingMount}
				table={defaultPrefixTable}
			/>,
		);

		const failed = screen.getByRole("region", {name: "Window window-1"});
		expect(failed.textContent).toContain("process process-1");
		expect(failed.textContent).toContain(THROWN);
	});
});

describe("recovery", () => {
	it("renders the children again when the button is pressed and the throw is gone", () => {
		const {rerender} = render(<DeskHarness initial={desk()} throwing />);
		rerender(<DeskHarness initial={desk()} throwing={false} />);

		act(() => {
			fireEvent.click(screen.getByRole("button", {name: "Render it again"}));
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("the window rendered")).toBeDefined();
	});

	it("clears itself when a resetKey changes, with no press at all", () => {
		function Harness({
			fail,
			token,
		}: {
			readonly fail: boolean;
			readonly token: number;
		}): ReactElement {
			return (
				<ErrorBoundary label="The desk layout" resetKeys={[token]}>
					<Thrower fail={fail} />
				</ErrorBoundary>
			);
		}
		const {rerender} = render(<Harness fail token={1} />);
		expect(screen.getByRole("alert")).toBeDefined();

		rerender(<Harness fail={false} token={2} />);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("the window rendered")).toBeDefined();
	});
});

describe("recovery under live kernel traffic", () => {
	/** The desk after `<c-b> |`: the same stack, one window more. */
	const splitDesk = (): ShellState =>
		deskWith(
			createTree(
				createStack("stack-root", "horizontal", [
					createWindow("window-1", "process-1"),
					createWindow("window-2"),
				]),
			),
			"window-1",
		);

	/** A snapshot as the page receives one: JSON off the socket, decoded fresh, guarded. */
	const overTheWire = (state: ShellState): ShellState => {
		const value: unknown = JSON.parse(JSON.stringify(state));
		if (!isShellState(value)) throw new Error("the fixture did not survive the wire");
		return value;
	};

	function ControlledDesk({
		state,
		throwing,
	}: {
		readonly state: ShellState;
		readonly throwing: boolean;
	}): ReactElement {
		return (
			<Desk
				state={state}
				dispatch={() => {}}
				press={() => Promise.resolve(refused)}
				resolveMount={throwingMount(throwing)}
				table={defaultPrefixTable}
			/>
		);
	}

	const resetButton = () => screen.getByRole("button", {name: "Render it again"});

	it("holds the panel, its opened <details> and focus through snapshots that leave the layout alone", () => {
		const {rerender} = render(<ControlledDesk state={desk()} throwing />);

		const alert = screen.getByRole("alert");
		const where = alert.querySelector("details");
		if (where === null) throw new Error("the panel showed no component stack to keep open");
		where.open = true;
		resetButton().focus();

		// Three snapshots of the same layout: identical content, then an unrelated field moving.
		rerender(<ControlledDesk state={overTheWire(desk())} throwing />);
		rerender(<ControlledDesk state={overTheWire(desk())} throwing />);
		rerender(<ControlledDesk state={overTheWire({...desk(), nextId: 9})} throwing />);

		expect(screen.getByRole("alert")).toBe(alert);
		expect(alert.querySelector("details")?.open).toBe(true);
		expect(document.activeElement).toBe(resetButton());
	});

	it("keeps one window's panel while a window the same snapshot opened renders beside it", () => {
		const {rerender} = render(<ControlledDesk state={desk()} throwing />);
		expect(screen.getByRole("alert")).toBeDefined();

		rerender(<ControlledDesk state={overTheWire(splitDesk())} throwing={false} />);

		// A window boundary resets on its own process's identity and not on the layout, so the failed
		// window holds its panel until the founder presses the button — and the new window renders
		// regardless, which is the containment #8157 asked for.
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getAllByText("the window rendered")).toHaveLength(1);

		act(() => {
			fireEvent.click(resetButton());
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getAllByText("the window rendered")).toHaveLength(2);
	});
});

function Thrower({fail}: {readonly fail: boolean}): ReactElement {
	if (fail) throw new Error(THROWN);
	return <p>the window rendered</p>;
}
