/**
 * @vitest-environment jsdom
 *
 * The layout binding against the real `react-resizable-panels@4.12.3`. Every claim the amendment on
 * #7559 rests on is checked here against the library rather than against a double, because the
 * binding exists only because the library behaves in ways a naive `defaultLayout` does not
 * (`.patterns/layout-tree-with-resizable-panels.md`).
 */

import {act, fireEvent, render, screen} from "@testing-library/react";
import type {ReactElement} from "react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {applyMsg} from "../core/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {createStack, createTree, createWindow} from "../layout/index.ts";
import {installDomShims} from "./dom.testing.ts";
import {deskWith, threeWindowDesk, threeWindowTree} from "./fixtures.ts";
import {zoomedWindow} from "./frame.ts";
import {LayoutView} from "./LayoutView.tsx";

installDomShims();

interface TreeHarnessProps {
	readonly initial: ShellState;
	readonly sent: Array<ShellMsg>;
}

/** Just the tiling area: the desk's chrome is `desk.unit.test.tsx`'s subject, not this file's. */
function TreeHarness({initial, sent}: TreeHarnessProps): ReactElement {
	const [state, setState] = useState(initial);
	return (
		<TreeView
			state={state}
			sent={sent}
			onMsg={(msg) => setState((current) => applyMsg(defaultPrefixTable, current, msg)[0])}
		/>
	);
}

/** The tree at exactly the state handed in — what a rerender-driven test needs. */
function TreeView({
	state,
	sent,
	onMsg = () => {},
}: {
	readonly state: ShellState;
	readonly sent: Array<ShellMsg>;
	readonly onMsg?: (msg: ShellMsg) => void;
}): ReactElement {
	const workspace = state.workspaces[state.activeWorkspace];
	if (workspace === undefined) throw new Error("test setup: no active workspace");
	return (
		<LayoutView
			root={workspace.layout.root}
			zoomed={zoomedWindow(workspace)}
			renderWindow={(windowId) => <div data-window-id={windowId}>{windowId}</div>}
			dispatch={(msg) => {
				sent.push(msg);
				onMsg(msg);
			}}
		/>
	);
}

const resizes = (sent: ReadonlyArray<ShellMsg>) =>
	sent.filter((msg) => msg.type === "layout.resize");

describe("the panel binding", () => {
	it("keys every Panel by its node id, never by its position", () => {
		const {container} = render(<TreeHarness initial={threeWindowDesk()} sent={[]} />);
		const ids = [...container.querySelectorAll("[data-panel]")].map((node) => node.id);
		expect(ids).toEqual(["window-1", "stack-right", "window-2", "window-3"]);
	});

	it("takes the tree's sizes for first paint", () => {
		const {container} = render(<TreeHarness initial={threeWindowDesk()} sent={[]} />);
		const first = container.querySelector<HTMLElement>("#window-1");
		const second = container.querySelector<HTMLElement>("#stack-right");
		expect(Number(first?.style.flexGrow)).toBeCloseTo(60, 1);
		expect(Number(second?.style.flexGrow)).toBeCloseTo(40, 1);
	});

	it("dispatches nothing on mount — the initial layout is not a user interaction", () => {
		const sent: Array<ShellMsg> = [];
		render(<TreeHarness initial={threeWindowDesk()} sent={sent} />);
		expect(resizes(sent)).toEqual([]);
	});

	it("gives every pair of panels a separator, and the separator carries its own keys", () => {
		render(<TreeHarness initial={threeWindowDesk()} sent={[]} />);
		const separators = screen.getAllByRole("separator");
		// Two stacks of two children: one divider each. The library attaches a `keydown` to each of
		// these elements itself (`Group.tsx`), which is why the desk's rule is one *application-level*
		// listener rather than one listener full stop.
		expect(separators).toHaveLength(2);
		expect(separators[0]?.getAttribute("aria-valuenow")).not.toBeNull();
	});
});

describe("a user resize", () => {
	it("sends exactly one layout.resize for one keyboard resize gesture", () => {
		const sent: Array<ShellMsg> = [];
		render(<TreeHarness initial={threeWindowDesk()} sent={sent} />);
		const separator = screen.getAllByRole("separator")[0] as HTMLElement;

		act(() => {
			fireEvent.keyDown(separator, {key: "ArrowRight"});
		});

		const resized = resizes(sent);
		expect(resized).toHaveLength(1);
		expect(resized[0]).toMatchObject({type: "layout.resize", stackId: "stack-root"});
	});

	it("writes nothing to localStorage — the surface never calls useDefaultLayout", () => {
		const sent: Array<ShellMsg> = [];
		render(<TreeHarness initial={threeWindowDesk()} sent={sent} />);
		const separator = screen.getAllByRole("separator")[0] as HTMLElement;

		act(() => {
			fireEvent.keyDown(separator, {key: "ArrowRight"});
			fireEvent.keyDown(separator, {key: "ArrowLeft"});
		});

		expect(localStorage.length).toBe(0);
		expect(localStorage.getItem("react-resizable-panels:stack-root")).toBeNull();
	});
});

describe("a resize arriving from the kernel", () => {
	it("is applied through setLayout and does not bounce back as a Msg", () => {
		const sent: Array<ShellMsg> = [];
		const {container, rerender} = render(
			<Mirror sizes={{"window-1": 60, "stack-right": 40}} sent={sent} />,
		);
		expect(Number(container.querySelector<HTMLElement>("#window-1")?.style.flexGrow)).toBeCloseTo(
			60,
			1,
		);

		// A second tab finished a drag: the kernel's sizes changed under a Group that was mounted with
		// the old ones. `defaultLayout` is read once, so only `setLayout` can move the DOM here.
		act(() => {
			rerender(<Mirror sizes={{"window-1": 25, "stack-right": 75}} sent={sent} />);
		});

		expect(Number(container.querySelector<HTMLElement>("#window-1")?.style.flexGrow)).toBeCloseTo(
			25,
			1,
		);
		expect(resizes(sent)).toEqual([]);
	});
});

function Mirror({
	sizes,
	sent,
}: {
	readonly sizes: Record<string, number>;
	readonly sent: Array<ShellMsg>;
}): ReactElement {
	const root = createStack(
		"stack-root",
		"horizontal",
		[createWindow("window-1"), createStack("stack-right", "vertical", [createWindow("window-2")])],
		sizes,
	);
	return (
		<LayoutView
			root={root}
			zoomed={null}
			renderWindow={(windowId) => <div data-window-id={windowId}>{windowId}</div>}
			dispatch={(msg) => sent.push(msg)}
		/>
	);
}

describe("zoom", () => {
	it("renders the zoomed window alone, and unzoom restores the split with no resize Msg", () => {
		const sent: Array<ShellMsg> = [];
		const zoomed = deskWith({...threeWindowTree(), zoomed: "window-3"});
		const {container, rerender} = render(<TreeView state={zoomed} sent={sent} />);

		expect(container.querySelectorAll("[data-panel]")).toHaveLength(0);
		expect(container.querySelector('[data-window-id="window-3"]')).not.toBeNull();
		expect(container.querySelector('[data-window-id="window-1"]')).toBeNull();

		act(() => {
			rerender(<TreeView state={threeWindowDesk()} sent={sent} />);
		});

		const ids = [...container.querySelectorAll("[data-panel]")].map((node) => node.id);
		expect(ids).toEqual(["window-1", "stack-right", "window-2", "window-3"]);
		expect(Number(container.querySelector<HTMLElement>("#window-1")?.style.flexGrow)).toBeCloseTo(
			60,
			1,
		);
		expect(resizes(sent)).toEqual([]);
	});

	it("leaves the tree's sizes untouched across a zoom round trip", () => {
		const before = threeWindowDesk("window-3");
		const [zoomed] = applyMsg(defaultPrefixTable, before, {type: "layout.zoom"});
		const [restored] = applyMsg(defaultPrefixTable, zoomed, {type: "layout.zoom"});
		expect(restored.workspaces["workspace-0"]?.layout.root.sizes).toEqual(
			before.workspaces["workspace-0"]?.layout.root.sizes,
		);
	});
});

describe("a split of a sibling", () => {
	it("leaves the untouched panel's size where it was", () => {
		const desk = deskWith(
			createTree(
				createStack(
					"stack-root",
					"horizontal",
					[createWindow("window-1"), createWindow("window-2")],
					{"window-1": 70, "window-2": 30},
				),
			),
			"window-2",
		);
		const [split] = applyMsg(defaultPrefixTable, desk, {
			type: "window.split",
			orientation: "vertical",
		});
		const {container} = render(<TreeHarness initial={split} sent={[]} />);
		expect(Number(container.querySelector<HTMLElement>("#window-1")?.style.flexGrow)).toBeCloseTo(
			70,
			1,
		);
	});
});
