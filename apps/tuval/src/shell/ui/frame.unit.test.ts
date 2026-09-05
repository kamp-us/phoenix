import {describe, expect, it} from "vitest";
import {applyMsg} from "../core/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {createStack, createTree, createWindow, SIZE_TOLERANCE} from "../layout/index.ts";
import {deskWith, threeWindowDesk, threeWindowTree} from "./fixtures.ts";
import {
	defaultLayoutOf,
	panelWindows,
	routerPrefix,
	sameLayout,
	statusFrame,
	surfaceKey,
	zoomedWindow,
} from "./frame.ts";

const table = defaultPrefixTable;
const prefixPress = {key: "b", ctrlKey: true};

describe("surfaceKey", () => {
	it("hands an unprefixed key to the focused window and nothing else", () => {
		const answer = surfaceKey(table, routerPrefix(threeWindowDesk()), {key: "j"});
		expect(answer).toEqual({_tag: "ToWindow", key: "j"});
	});

	it("opens the command line on `prefix :`, and only after the prefix", () => {
		const idle = threeWindowDesk();
		expect(surfaceKey(table, routerPrefix(idle), {key: ":"})).toEqual({_tag: "ToWindow", key: ":"});

		const [armed] = applyMsg(table, idle, {type: "keys.press", key: prefixPress});
		expect(surfaceKey(table, routerPrefix(armed), {key: ":"})).toEqual({_tag: "OpenCommandLine"});
	});

	it("keeps every other bound sequence the shell's, naming the command it resolved", () => {
		const [armed] = applyMsg(table, threeWindowDesk(), {type: "keys.press", key: prefixPress});
		const answer = surfaceKey(table, routerPrefix(armed), {key: "|"});
		expect(answer).toEqual({_tag: "Shell", command: "window:split-vertical"});
	});

	it("answers the same way the core routes: arming names no command", () => {
		const answer = surfaceKey(table, routerPrefix(threeWindowDesk()), prefixPress);
		expect(answer).toEqual({_tag: "Shell", command: null});
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
