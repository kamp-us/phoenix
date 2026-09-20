import {describe, expect, it} from "vitest";
import {ProcessId} from "../../process/process.ts";
import type {ShellState} from "../core/index.ts";
import {applyMsg} from "../core/index.ts";
import type {Key} from "../keys/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {createStack, createTree, createWindow, SIZE_TOLERANCE} from "../layout/index.ts";
import {delivered, processGone} from "../window/host.ts";
import {deskWith, threeWindowDesk, threeWindowTree} from "./fixtures.ts";
import {
	defaultLayoutOf,
	holdsPanels,
	panelWindows,
	routerPrefix,
	sameLayout,
	shellOwnsKey,
	statusFrame,
	zoomedWindow,
} from "./frame.ts";
import {refused, replyIn, replyOf} from "./press.ts";

const table = defaultPrefixTable;
const prefixPress: Key = {key: "b", ctrlKey: true};

describe("shellOwnsKey", () => {
	it("takes the prefix key from an idle prefix, and leaves every other key alone", () => {
		const idleDesk = routerPrefix(threeWindowDesk());
		expect(shellOwnsKey(table, idleDesk, prefixPress)).toBe(true);
		expect(shellOwnsKey(table, idleDesk, {key: "j"})).toBe(false);
	});

	it("takes every key while the prefix is armed, bound or not", () => {
		const [armed] = applyMsg(table, threeWindowDesk(), {type: "keys.press", key: prefixPress});
		expect(shellOwnsKey(table, routerPrefix(armed), {key: "|"})).toBe(true);
		expect(shellOwnsKey(table, routerPrefix(armed), {key: "q"})).toBe(true);
	});
});

describe("the kernel's answer to one press", () => {
	const pressed = (state: ShellState, key: Key, pressId: string): ShellState =>
		applyMsg(table, state, {type: "keys.press", key, pressId})[0];

	it("reads the answer to this page's own press off the state the acknowledgement carried", () => {
		const armed = pressed(threeWindowDesk(), prefixPress, "page-1");
		expect(replyIn("page-1", armed)).toEqual({_tag: "Consumed"});

		const commanded = pressed(armed, {key: "h"}, "page-2");
		expect(replyIn("page-2", commanded)).toEqual({_tag: "Command", name: "window:focus-left"});

		const forwarded = pressed(commanded, {key: "j"}, "page-3");
		expect(replyIn("page-3", forwarded)).toEqual({_tag: "ToWindow", key: "j"});
	});

	// A second page on the same shell writes `lastPress` too. Reading its answer as this page's
	// would forward a key nobody here pressed, so an id that is not ours is no answer at all.
	it("refuses an answer stamped by anyone else, and a state it cannot read", () => {
		const other = pressed(threeWindowDesk(), {key: "j"}, "other-page-1");
		expect(replyIn("page-1", other)).toEqual(refused);
		expect(replyIn("page-1", {not: "a shell state"})).toEqual(refused);
	});

	it("refuses a dispatch the kernel never applied, and one that carried no state", () => {
		const forwarded = pressed(threeWindowDesk(), {key: "j"}, "page-1");
		expect(replyOf("page-1", processGone(ProcessId.make("process-1")))).toEqual(refused);
		expect(replyOf("page-1", delivered)).toEqual(refused);
		expect(replyOf("page-1", {_tag: "Delivered", view: {revision: 3, state: forwarded}})).toEqual({
			_tag: "ToWindow",
			key: "j",
		});
	});
});

describe("statusFrame", () => {
	it("names the workspace, its position, the window count and an idle prefix", () => {
		const frame = statusFrame(threeWindowDesk());
		expect(frame.workspace).toBe("workspace-0");
		expect(frame.position).toEqual({at: 1, of: 1});
		expect(frame.windowCount).toBe(3);
		expect(frame.prefixArmed).toBe(false);
		expect(frame.pending).toEqual([]);
		expect(frame.zoomed).toBe(false);
		expect(frame.announcement).toBe("Prefix idle.");
	});

	it("shows the armed prefix and the sequence typed since it armed", () => {
		const [armed] = applyMsg(table, threeWindowDesk(), {type: "keys.press", key: prefixPress});
		expect(statusFrame(armed).prefixArmed).toBe(true);
		expect(statusFrame(armed).announcement).toBe("Prefix armed, waiting for a sequence.");

		// `<c-b>` then `<c-` is the start of `<c-h>`/`<c-l>` and completes nothing, so it stays pending.
		const [pending] = applyMsg(table, armed, {type: "keys.press", key: {key: "q"}});
		expect(statusFrame(pending).pending).toEqual([]);

		const [waiting] = applyMsg(table, armed, {type: "keys.press", key: {key: "b", ctrlKey: true}});
		expect(statusFrame(waiting).prefixArmed).toBe(false);
	});

	it("says a workspace is zoomed", () => {
		const zoomed = deskWith({...threeWindowTree(), zoomed: "window-3"});
		expect(statusFrame(zoomed).zoomed).toBe(true);
	});
});

describe("the panel layout", () => {
	it("keys sizes by node id, so a sibling split cannot re-point them", () => {
		const stack = threeWindowTree().root;
		expect(defaultLayoutOf(stack)).toEqual({"window-1": 60, "stack-right": 40});
	});

	it("walks every window in reading order", () => {
		expect([...panelWindows(threeWindowTree().root)]).toEqual(["window-1", "window-2", "window-3"]);
	});

	it("calls a rounded report the same layout, and a real move a different one", () => {
		const stack = threeWindowTree().root;
		expect(sameLayout(stack, {"window-1": 60.004, "stack-right": 39.996}, SIZE_TOLERANCE)).toBe(
			true,
		);
		expect(sameLayout(stack, {"window-1": 70, "stack-right": 30}, SIZE_TOLERANCE)).toBe(false);
	});

	it("answers the panel set separately from the sizes, in both directions", () => {
		// `sameLayout` alone cannot tell these apart: a child the group never registered reports
		// `undefined`, which its per-key predicate waves through as agreement (#7839).
		const stack = threeWindowTree().root;
		expect(holdsPanels(stack, {"window-1": 60, "stack-right": 40})).toBe(true);
		expect(holdsPanels(stack, {"window-1": 100})).toBe(false);
		expect(holdsPanels(stack, {"window-1": 40, "stack-right": 30, "window-9": 30})).toBe(false);
		expect(holdsPanels(stack, {})).toBe(false);
		expect(sameLayout(stack, {"window-1": 100}, SIZE_TOLERANCE)).toBe(false);
		expect(sameLayout(stack, {"window-1": 60}, SIZE_TOLERANCE)).toBe(true);
	});

	it("reads zoom off the tree, and refuses a `zoomed` naming no window", () => {
		const tree = threeWindowTree();
		const workspace = {
			id: "workspace-0",
			layout: {...tree, zoomed: "window-2"},
			focused: "window-1",
		};
		expect(zoomedWindow(workspace)).toBe("window-2");
		expect(zoomedWindow({...workspace, layout: {...tree, zoomed: "window-404"}})).toBeNull();
		expect(zoomedWindow({...workspace, layout: tree})).toBeNull();
	});
});

describe("the layout Msgs the surface sends", () => {
	it("writes one stack's sizes and leaves the rest of the tree alone", () => {
		const before = threeWindowDesk();
		const [after] = applyMsg(table, before, {
			type: "layout.resize",
			stackId: "stack-root",
			sizes: {"window-1": 30, "stack-right": 70},
		});
		const workspace = after.workspaces["workspace-0"];
		expect(workspace?.layout.root.sizes).toEqual({"window-1": 30, "stack-right": 70});
		expect(workspace?.focused).toBe("window-1");
	});

	it("toggles zoom without ever writing sizes, so unzoom restores the split", () => {
		const before = threeWindowDesk("window-3");
		const [zoomed] = applyMsg(table, before, {type: "layout.zoom"});
		expect(zoomed.workspaces["workspace-0"]?.layout.zoomed).toBe("window-3");

		const [restored] = applyMsg(table, zoomed, {type: "layout.zoom"});
		expect(restored.workspaces["workspace-0"]?.layout.zoomed).toBeNull();
		expect(restored.workspaces["workspace-0"]?.layout.root.sizes).toEqual(
			before.workspaces["workspace-0"]?.layout.root.sizes,
		);
	});

	it("leaves the desk untouched when the stack is not there", () => {
		const before = threeWindowDesk();
		const [after] = applyMsg(table, before, {
			type: "layout.resize",
			stackId: "stack-404",
			sizes: {"window-1": 1},
		});
		expect(after).toBe(before);
	});

	it("splits a sibling without moving another stack's stored sizes", () => {
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
		const [split] = applyMsg(table, desk, {type: "window.split", orientation: "vertical"});
		const root = split.workspaces["workspace-0"]?.layout.root;
		// `window-1` keeps its 70 because the map is keyed by its id, never by "the first panel".
		expect(root?.sizes["window-1"]).toBe(70);
	});
});
