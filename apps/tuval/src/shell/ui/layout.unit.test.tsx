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

	it("carries the state attribute the stylesheet paints, and a name per pair", () => {
		// The stylesheet used to hang its drag highlight on `data-resize-handle-active`, which the
		// pinned major never emits, so the highlight never painted (#7499). `data-separator` is the
		// state at this pin; `aria-label` is per separator, so a group of three names three things.
		render(<TreeHarness initial={threeWindowDesk()} sent={[]} />);
		const separators = screen.getAllByRole("separator");
		expect(separators.map((one) => one.getAttribute("data-separator"))).toEqual([
			"inactive",
			"inactive",
		]);
		expect(separators.some((one) => one.hasAttribute("data-resize-handle-active"))).toBe(false);
		const names = separators.map((one) => one.getAttribute("aria-label"));
		expect(new Set(names).size).toBe(names.length);
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

/**
 * The desk as a founder finds it: one workspace, one window, the root stack `"horizontal"` — which
 * is what `workspace.create` builds (`../core/machine.ts`).
 */
const singleWindowDesk = (): ShellState =>
	deskWith(
		createTree(createStack("stack-root", "horizontal", [createWindow("window-1")])),
		"window-1",
	);

const pressed = (state: ShellState, key: string, ctrlKey = false): ShellState =>
	applyMsg(defaultPrefixTable, state, {type: "keys.press", key: {key, ctrlKey}})[0];

/** `<c-b>` then a sequence key, through the same table the desk routes against. */
const gesture = (state: ShellState, sequence: string): ShellState =>
	pressed(pressed(state, "b", true), sequence);

const panelIds = (container: HTMLElement): ReadonlyArray<string> =>
	[...container.querySelectorAll("[data-panel]")].map((node) => node.id);

/** Render `from`, then hand the tree `to` — the live rerender, which is the only path that throws. */
const rerenderAcross = (from: ShellState, to: ShellState) => {
	const {container, rerender} = render(<TreeView state={from} sent={[]} />);
	act(() => {
		rerender(<TreeView state={to} sent={[]} />);
	});
	return container;
};

describe("a gesture that changes a stack's panel set", () => {
	// Every case here is a *rerender*, not a render of the finished state: `defaultLayout` is read
	// at registration and `setLayout` never runs on a first mount, so mounting the split desk proves
	// nothing about the effect. Before #7839 three of the four threw out of the library — `Invalid 1
	// panel layout: 50%, 50%`, `Invalid 2 panel layout: 100%`, `Invalid 2 panel layout: 40%, 40%,
	// 20%`. `<c-b> -` was the one that passed, and only by accident: it flips the one-child stack's
	// orientation, which is a dependency of the group's own registration effect, so that group
	// re-registers in the same commit and is holding both panels by the time this effect runs.
	// Nothing about the fix rests on that, which is why it is a case here rather than a footnote.
	it("splits the only window of a stack with <c-b> | and hands the group two panels", () => {
		const desk = singleWindowDesk();
		const container = rerenderAcross(desk, gesture(desk, "|"));
		expect(panelIds(container)).toHaveLength(2);
	});

	it("splits the only window of a stack with <c-b> -", () => {
		const desk = singleWindowDesk();
		const container = rerenderAcross(desk, gesture(desk, "-"));
		expect(panelIds(container)).toHaveLength(2);
	});

	it("closes a window with <c-b> x, back from two panels to one", () => {
		const split = gesture(singleWindowDesk(), "|");
		const container = rerenderAcross(split, gesture(split, "x"));
		expect(panelIds(container)).toHaveLength(1);
	});

	it("carries the kernel's uneven sizes across the change, through defaultLayout", () => {
		// The write-back is skipped on a panel-set change, so this is the whole proof that the sizes
		// still arrive: the group reads the current `defaultLayout` prop when it re-registers.
		const desk = deskWith(
			createTree(
				createStack(
					"stack-root",
					"horizontal",
					[createWindow("window-1"), createWindow("window-2")],
					{"window-1": 80, "window-2": 20},
				),
			),
			"window-1",
		);
		const split = gesture(desk, "|");
		const container = rerenderAcross(desk, split);
		const root = split.workspaces["workspace-0"]?.layout.root;
		expect(root?.children).toHaveLength(3);
		for (const child of root?.children ?? []) {
			expect(
				Number(container.querySelector<HTMLElement>(`#${child.id}`)?.style.flexGrow),
			).toBeCloseTo(root?.sizes[child.id] ?? Number.NaN, 1);
		}
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
