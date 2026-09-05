/**
 * @vitest-environment jsdom
 *
 * The boundary, proved through the desk rather than in isolation: what #7839 cost a founder was not
 * "an uncaught error" but a blank tab, so the assertions are about what is still on the page after a
 * window renderer throws.
 */

import {act, fireEvent, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {useState} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ProcessId} from "../../process/process.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {applyMsg, isShellState} from "../core/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {createStack, createTree, createWindow} from "../layout/index.ts";
import {Desk} from "./Desk.tsx";
import {installDomShims} from "./dom.testing.ts";
import {ErrorBoundary} from "./ErrorBoundary.tsx";
import {deskWith} from "./fixtures.ts";
import type {MountResolver} from "./mount.ts";

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
	const [state, setState] = useState(initial);
	return (
		<Desk
			state={state}
			dispatch={(msg: ShellMsg) =>
				setState((current) => applyMsg(defaultPrefixTable, current, msg)[0])
			}
			resolveMount={throwingMount(throwing)}
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
		expect(alert.textContent).toContain("The desk layout stopped rendering.");
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
		return <Desk state={state} dispatch={() => {}} resolveMount={throwingMount(throwing)} />;
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

	it("clears itself when a snapshot does change the layout", () => {
		const {rerender} = render(<ControlledDesk state={desk()} throwing />);
		expect(screen.getByRole("alert")).toBeDefined();

		rerender(<ControlledDesk state={overTheWire(splitDesk())} throwing={false} />);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getAllByText("the window rendered")).toHaveLength(2);
	});
});

function Thrower({fail}: {readonly fail: boolean}): ReactElement {
	if (fail) throw new Error(THROWN);
	return <p>the window rendered</p>;
}
