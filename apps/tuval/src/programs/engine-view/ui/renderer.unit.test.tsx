/**
 * @vitest-environment jsdom
 *
 * The engine view's window, mounted through a test-double `WindowHost` over a fixture `Snapshot`.
 *
 * The tier is `unit`: every claim here could be wrong with a perfectly healthy socket, which is the
 * litmus (`.patterns/effect-testing.md`). Nothing is wired but the window contract's double and the
 * desk provider — no kernel, no socket, no `ProcessTablePort` — which is itself one of the claims.
 */

import {act, fireEvent, render} from "@testing-library/react";
import {Effect} from "effect";
import {beforeEach, describe, expect, it} from "vitest";
import {ProcessId, ProgramId} from "../../../protocol/ids.ts";
import type {ProcessRow} from "../../../protocol/process-row.ts";
import {type TestProcess, testProcess} from "../../../shell/window/fixtures.ts";
import {WindowId} from "../../../shell/window/host.ts";
import {type EngineViewMsg, type EngineViewState, engineViewInitial} from "../program.ts";
import {DeskAccessProvider, type SpellCaller} from "./desk.tsx";
import {installEngineViewDomShims} from "./dom.testing.ts";
import {engineViewReactRenderer} from "./renderer.tsx";

installEngineViewDomShims();

const pid = (id: string): ProcessId => ProcessId.make(id);

const row = (
	id: string,
	parentId: string | null,
	ports: ProcessRow["ports"] = {},
	recency = 1,
): ProcessRow => ({
	id: pid(id),
	programId: ProgramId.make("counter"),
	parentId: parentId === null ? null : pid(parentId),
	ports,
	stateSummary: {lifecycle: "running", revision: 3},
	recency,
});

/** A root, its one child, and an unrelated second root — the shape a process table takes at once. */
const snapshotProcesses: ReadonlyArray<ProcessRow> = [
	row("p-root", null, {ticks: {kind: "tuval/count", direction: "out"}}),
	row("p-child", "p-root", {prompt: {kind: "tuval/prompt", direction: "in"}}, 2),
	row("p-other", null, {}, 3),
];

interface Mounted {
	readonly process: TestProcess<EngineViewState, EngineViewMsg>;
	readonly calls: Array<readonly [ReadonlyArray<string>, Readonly<Record<string, unknown>>]>;
	readonly nodes: () => ReadonlyArray<HTMLElement>;
	readonly node: (id: string) => HTMLElement;
	readonly edges: () => ReadonlyArray<Element>;
	readonly rerender: (processes: ReadonlyArray<ProcessRow>) => Promise<void>;
	readonly commit: (state: EngineViewState) => Promise<void>;
}

const mount = async (
	processes: ReadonlyArray<ProcessRow> = snapshotProcesses,
): Promise<Mounted> => {
	const process = await Effect.runPromise(
		testProcess<EngineViewState, EngineViewMsg>(pid("p-engine-view"), engineViewInitial),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("window-1"), null));
	const calls: Array<readonly [ReadonlyArray<string>, Readonly<Record<string, unknown>>]> = [];
	const callSpell: SpellCaller = (path, args) => void calls.push([[...path], args]);
	const view = (rows: ReadonlyArray<ProcessRow>) => (
		<DeskAccessProvider value={{processes: rows, callSpell}}>
			{engineViewReactRenderer(host)}
		</DeskAccessProvider>
	);
	const result = render(view(processes));
	// The first state arrives on a forked fiber, so one turn has to pass before the canvas has it.
	await act(async () => {});
	const nodes = () => [...result.container.querySelectorAll<HTMLElement>(".react-flow__node")];
	return {
		process,
		calls,
		nodes,
		node: (id) => {
			const found = nodes().find((element) => element.getAttribute("data-id") === id);
			if (found === undefined) throw new Error(`test setup: no node for ${id}`);
			return found;
		},
		edges: () => [...result.container.querySelectorAll(".react-flow__edge")],
		rerender: async (rows) => {
			result.rerender(view(rows));
			await act(async () => {});
		},
		commit: async (state) => {
			await Effect.runPromise(process.commit(state));
			await act(async () => {});
		},
	};
};

/**
 * A mouse event carrying its `view`. React Flow's pane runs d3-zoom's `nodrag(event.view)` on every
 * mousedown that reaches it, and a `null` view throws there before any assertion is reached — while
 * `fireEvent.mouseDown` builds the event without one.
 *
 * `view` is assigned afterwards rather than passed to the constructor because under Vitest the
 * global `window` is a proxy over jsdom's, so jsdom's own `MouseEvent` brand check rejects it as
 * "not of type Window" whichever way it is reached. An own property shadows the prototype getter,
 * which is all d3 reads.
 */
const mouse = (type: string, target: Element, position: {x: number; y: number}): void => {
	const view = target.ownerDocument.defaultView;
	if (view === null) throw new Error("test setup: the element is not in a rendered document");
	const event = new view.MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: position.x,
		clientY: position.y,
	});
	Object.defineProperty(event, "view", {value: view, configurable: true});
	fireEvent(target, event);
};

describe("engine view: what it renders", () => {
	it("draws one node per row and one edge per resolved parent", async () => {
		const mounted = await mount();
		expect(
			mounted
				.nodes()
				.map((node) => node.getAttribute("data-id"))
				.toSorted(),
		).toEqual(["p-child", "p-other", "p-root"]);
		expect(mounted.edges()).toHaveLength(1);
	});

	it("shows the process id, the program id, the ports and the lifecycle on the node", async () => {
		const mounted = await mount();
		const node = mounted.node("p-child");
		expect(node.textContent).toContain("p-child");
		expect(node.textContent).toContain("counter");
		expect(node.textContent).toContain("prompt");
		expect(node.textContent).toContain("tuval/prompt");
		expect(node.textContent).toContain("running");
	});

	it("takes `Snapshot.processes` as its only source of process facts", async () => {
		// Nothing is wired here but the window double and the snapshot rows: no kernel, no socket, no
		// `ProcessTablePort`. An empty array is therefore an empty canvas, and adding a row adds a node.
		const mounted = await mount([]);
		expect(mounted.nodes()).toEqual([]);
		await mounted.rerender([row("p-only", null)]);
		expect(mounted.nodes().map((node) => node.getAttribute("data-id"))).toEqual(["p-only"]);
	});

	it("renders dark, with React Flow's own colour mode set rather than its default", async () => {
		const mounted = await mount();
		expect(mounted.node("p-root").closest(".react-flow")?.classList.contains("dark")).toBe(true);
	});
});

describe("engine view: nothing an interaction does reaches the graph", () => {
	let mounted: Mounted;

	const shape = () => ({
		nodes: mounted.nodes().map((node) => `${node.getAttribute("data-id")}@${node.style.transform}`),
		edges: mounted.edges().map((edge) => edge.getAttribute("data-id")),
	});

	beforeEach(async () => {
		mounted = await mount();
	});

	it("marks no node draggable, selectable or connectable", async () => {
		for (const node of mounted.nodes()) {
			expect(node.classList.contains("draggable")).toBe(false);
			expect(node.classList.contains("selectable")).toBe(false);
			expect(node.classList.contains("connectable")).toBe(false);
		}
	});

	it("leaves the graph identical after a node drag", async () => {
		const before = shape();
		const node = mounted.node("p-root");
		mouse("mousedown", node, {x: 0, y: 0});
		mouse("mousemove", node, {x: 220, y: 180});
		mouse("mouseup", node, {x: 220, y: 180});
		await act(async () => {});
		expect(shape()).toEqual(before);
	});

	it("leaves the graph identical after an edge drag off a handle", async () => {
		const before = shape();
		const handle = mounted.node("p-root").querySelector(".react-flow__handle");
		expect(handle).not.toBeNull();
		mouse("mousedown", handle as Element, {x: 0, y: 0});
		mouse("mousemove", handle as Element, {x: 200, y: 200});
		mouse("mouseup", handle as Element, {x: 200, y: 200});
		await act(async () => {});
		expect(shape()).toEqual(before);
	});

	it("leaves the graph identical after a connect attempt onto another node", async () => {
		const before = shape();
		const source = mounted.node("p-root").querySelector(".react-flow__handle");
		const target = mounted.node("p-other");
		mouse("mousedown", source as Element, {x: 0, y: 0});
		mouse("mousemove", target, {x: 400, y: 400});
		mouse("mouseup", target, {x: 400, y: 400});
		await act(async () => {});
		expect(shape()).toEqual(before);
		expect(mounted.process.inbox()).toEqual([]);
	});
});

describe("engine view: selecting and attaching", () => {
	it("writes the selected process id into the program's state", async () => {
		const mounted = await mount();
		fireEvent.click(mounted.node("p-child"));
		await act(async () => {});
		expect(mounted.process.inbox()).toEqual([{type: "select", processId: pid("p-child")}]);
	});

	it("selects the node keyboard focus lands on, so Tab reaches the same act as a click", async () => {
		const mounted = await mount();
		await act(async () => {
			mounted.node("p-other").focus();
		});
		expect(mounted.process.inbox()).toEqual([{type: "select", processId: pid("p-other")}]);
	});

	it("Enter on the selected node issues the attach call with that process id and nothing else", async () => {
		const mounted = await mount();
		fireEvent.click(mounted.node("p-child"));
		await mounted.commit({selected: pid("p-child")});
		expect(mounted.node("p-child").querySelector(".engine-node")).toHaveProperty(
			"dataset.selected",
			"true",
		);
		fireEvent.keyDown(mounted.node("p-child"), {key: "Enter"});
		expect(mounted.calls).toEqual([[["window", "attach"], {process: pid("p-child")}]]);
	});

	it("issues no call for any other key", async () => {
		const mounted = await mount();
		fireEvent.keyDown(mounted.node("p-child"), {key: "a"});
		fireEvent.keyDown(mounted.node("p-child"), {key: " "});
		expect(mounted.calls).toEqual([]);
	});

	it("clears a selection whose process has left the table", async () => {
		const mounted = await mount();
		await mounted.commit({selected: pid("p-child")});
		await mounted.rerender(snapshotProcesses.filter((process) => process.id !== pid("p-child")));
		expect(mounted.process.inbox()).toEqual([
			{type: "tableChanged", present: [pid("p-root"), pid("p-other")]},
		]);
	});

	it("leaves a selection alone while its process is still in the table", async () => {
		const mounted = await mount();
		await mounted.commit({selected: pid("p-child")});
		await mounted.rerender(snapshotProcesses);
		expect(mounted.process.inbox()).toEqual([]);
	});
});

describe("engine view: accessibility is React Flow's own", () => {
	it("keeps every node focusable and labelled by the library, with no layer added on top", async () => {
		const mounted = await mount();
		for (const node of mounted.nodes()) {
			expect(node.tabIndex).toBe(0);
			expect(node.getAttribute("role")).toBe("group");
			expect(node.getAttribute("aria-roledescription")).toBe("node");
			expect(node.getAttribute("aria-label")).toMatch(/^Process p-/);
		}
	});

	it("adds no bespoke tree, roving tabindex or live region of its own", async () => {
		const mounted = await mount();
		const canvas = mounted.node("p-root").closest(".engine-view");
		expect(canvas?.querySelectorAll('[role="tree"]')).toHaveLength(0);
		expect(canvas?.querySelectorAll('[tabindex="-1"]')).toHaveLength(0);
	});
});
