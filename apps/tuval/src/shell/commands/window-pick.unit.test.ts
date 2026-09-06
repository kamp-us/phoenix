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
import {activeWorkspace, keyTargetOf, type ShellState} from "../core/state.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {findWindow, windows} from "../layout/index.ts";
import {readEntries} from "../picker/entries.ts";
import {pickerHarness, programRow, shellProcessId} from "../picker/fixtures.ts";
import type {PickerIntent} from "../picker/intent.ts";
import {attachProcess, openProgram} from "../picker/intent.ts";
import {runPickerIntent} from "../picker/open.ts";
import {highlighted, mountPicker, type PickerKeyAnswer, pickerKey} from "../picker/view.ts";
import {asPickerView} from "../ui/PickerView.tsx";
import {WindowId} from "../window/index.ts";
import {commandFor} from "./table.ts";

const counter = programRow("counter", {label: "Counter"});
const keyed = programRow("keyed", {label: "Keyed", takesKeys: true});

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

const boundProcess = (state: ShellState, windowId: WindowId): string => {
	const id = processIn(state, windowId);
	if (id === null) throw new Error("test setup: nothing is bound to the window");
	return id;
};

const chosen = (answer: PickerKeyAnswer): PickerIntent => {
	if (answer._tag !== "Chose") throw new Error(`test setup: the key answered ${answer._tag}`);
	return answer.intent;
};

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
				// Fresh but for `previous`: #8083's "cursor 0" was about not leaking a stale cursor or
				// refusal, and #8265 refines it — the mount names the process Escape returns to.
				assert.deepStrictEqual(asPickerView(unbound.views[window]), mountPicker(spawned));

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

	it.effect("Escape on the picker it mounted puts the same process back (#8265)", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const harness = yield* pickerHarness([keyed]);
				const empty = initialState();
				const window = WindowId.make(workspaceOf(empty).focused);

				const opened = yield* runPickerIntent(openProgram(window, keyed.id), {
					shellProcessId,
				}).pipe(Effect.provide(harness.layer));
				const bound = opened.reduce(apply, empty);
				const spawned = boundProcess(bound, window);
				assert.strictEqual(keyTargetOf(workspaceOf(bound), window), spawned);

				const unbound = apply(bound, pickMsg());
				const entries = yield* readEntries.pipe(Effect.provide(harness.layer));
				const view = asPickerView(unbound.views[window]);

				// The picker mounts pointing at the row Escape returns to, so the operator can see it.
				assert.deepStrictEqual(highlighted(entries, view), {
					_tag: "Process",
					processId: ProcessId.make(spawned),
					programId: keyed.id,
					label: "Keyed",
					parentId: shellProcessId,
				});

				const intent = chosen(pickerKey(window, entries, view, "<escape>"));
				const returned = yield* runPickerIntent(intent, {shellProcessId}).pipe(
					Effect.provide(harness.layer),
				);
				const refilled = returned.reduce(apply, unbound);
				assert.strictEqual(processIn(refilled, window), spawned);
				// `takesKeys` came back with the binding, so the returned window is sent keys again.
				assert.strictEqual(keyTargetOf(workspaceOf(refilled), window), spawned);

				// One spawn on the whole trip: Escape attached, it never re-opened the program, and
				// nothing on the path could have stopped the process — the core has no arm for it.
				assert.strictEqual(harness.spawns().length, 1);
				assert.deepStrictEqual(
					returned.map((msg) => msg.type),
					["window.bind"],
				);
			}),
		),
	);

	it("Escape on a picker no `window:pick` mounted stays the dismiss key (#8265)", () => {
		const empty = initialState();
		const window = WindowId.make(workspaceOf(empty).focused);
		const view = asPickerView(empty.views[window]);
		assert.strictEqual(view.previous, null);
		assert.deepStrictEqual(pickerKey(window, {programs: [], processes: []}, view, "<escape>"), {
			_tag: "Ignored",
		});
	});

	it("does nothing to a window that is already on the picker", () => {
		const empty = initialState();
		const window = WindowId.make(workspaceOf(empty).focused);
		const moved = apply(empty, {type: "window.setView", windowId: window, view: {cursor: 1}});

		const after = apply(moved, pickMsg());
		assert.strictEqual(after, moved);
		assert.deepStrictEqual(asPickerView(after.views[window]), {
			cursor: 1,
			refusal: null,
			previous: null,
		});
	});
});
