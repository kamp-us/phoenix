/**
 * The `window:pick` round trip (#8083): a filled window goes back to the picker and takes the same
 * process back, in the same slot. The core reducer and the picker's real handler are driven
 * together here because the claim spans both — the reducer says the window is empty, and only the
 * process table can say the process it was showing is still running.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {ProcessId} from "../../process/process.ts";
import {applyMsg, initialState, type ShellMsg} from "../core/machine.ts";
import {activeWorkspace, type ShellState} from "../core/state.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {findWindow, windows} from "../layout/index.ts";
import {readEntries} from "../picker/entries.ts";
import {pickerHarness, programRow, shellProcessId} from "../picker/fixtures.ts";
import {attachProcess, openProgram} from "../picker/intent.ts";
import {runPickerIntent} from "../picker/open.ts";
import {mountPicker} from "../picker/view.ts";
import {asPickerView} from "../ui/PickerView.tsx";
import {WindowId} from "../window/index.ts";
import {commandFor} from "./table.ts";

const counter = programRow("counter", {label: "Counter"});

const apply = (state: ShellState, msg: ShellMsg): ShellState =>
	applyMsg(defaultPrefixTable, state, msg)[0];

const workspaceOf = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) throw new Error("test setup: no active workspace");
	return workspace;
};

const processIn = (state: ShellState, windowId: WindowId): string | null =>
	findWindow(workspaceOf(state).layout, windowId)?.processId ?? null;

const slots = (state: ShellState): ReadonlyArray<string> =>
	[...windows(workspaceOf(state).layout.root)].map((node) => node.id);

/** The Msg the key `<c-b> w` runs, read off the row rather than written out here. */
const pickMsg = (): ShellMsg => {
	const row = commandFor("window:pick");
	if (row === undefined) throw new Error("test setup: no window:pick row");
	return row.toMsg({});
};

describe("window:pick returns a filled window to the picker", () => {
	it.effect("unbinds the window, leaves the process running, and takes it back", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const harness = yield* pickerHarness([counter]);
				const empty = initialState();
				const window = WindowId.make(workspaceOf(empty).focused);

				const opened = yield* runPickerIntent(openProgram(window, counter.id), {
					shellProcessId,
				}).pipe(Effect.provide(harness.layer));
				const bound = opened.reduce(apply, empty);
				const spawned = processIn(bound, window);
				assert.isNotNull(spawned);

				// A moved highlight from the mount that opened this program, so a stale slot would be
				// visible rather than accidentally equal to a fresh one.
				const used = apply(bound, {type: "window.setView", windowId: window, view: {cursor: 1}});

				const unbound = apply(used, pickMsg());
				assert.isNull(processIn(unbound, window));
				assert.deepStrictEqual(slots(unbound), slots(used));
				assert.deepStrictEqual(asPickerView(unbound.views[window]), mountPicker());

				const entries = yield* readEntries.pipe(Effect.provide(harness.layer));
				const offered = entries.processes.map((entry) => String(entry.processId));
				assert.deepStrictEqual(offered, [spawned]);

				const reattached = yield* runPickerIntent(attachProcess(window, ProcessId.make(spawned)), {
					shellProcessId,
				}).pipe(Effect.provide(harness.layer));
				const refilled = reattached.reduce(apply, unbound);
				assert.strictEqual(processIn(refilled, window), spawned);
				assert.deepStrictEqual(slots(refilled), slots(used));

				// Nothing on the path closed a window or split one: the whole trip is bind, unbind, bind.
				assert.deepStrictEqual(
					[...opened, pickMsg(), ...reattached].map((msg) => msg.type),
					["window.bind", "window.unbind", "window.bind"],
				);
				assert.strictEqual(harness.spawns().length, 1);
			}),
		),
	);

	it("does nothing to a window that is already on the picker", () => {
		const empty = initialState();
		const window = WindowId.make(workspaceOf(empty).focused);
		const moved = apply(empty, {type: "window.setView", windowId: window, view: {cursor: 1}});

		const after = apply(moved, pickMsg());
		assert.strictEqual(after, moved);
		assert.deepStrictEqual(asPickerView(after.views[window]), {cursor: 1, refusal: null});
	});
});
