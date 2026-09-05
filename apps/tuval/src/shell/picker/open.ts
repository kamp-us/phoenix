/**
 * The one place a picker choice and a `window:open` / `window:attach` command line both end: resolve
 * the intent, then answer with the shell Msgs that follow. Open spawns one process under the shell
 * process and binds it; attach binds a process already running and spawns nothing — that second
 * arm is the door to the Vim buffer model, one process in many windows (#7484 R1.3).
 *
 * The error channel is `never` on purpose. A refusal is shown *in* the window, so it leaves as a
 * `window.setView` Msg carrying a `PickerRefusal`, and this handler's caller has no failure to
 * handle and no throw to catch.
 */

import {Context, Effect} from "effect";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProcessId} from "../../process/process.ts";
import {type AnyProgram, type ProgramId, takesForwardedKeys} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import type {ShellMsg} from "../core/machine.ts";
import type {WindowId} from "../window/host.ts";
import {showsInAWindow} from "./entries.ts";
import type {PickerIntent} from "./intent.ts";
import {
	type PickerRefusal,
	processGone,
	programHeadless,
	spawnFailed,
	unknownProgram,
} from "./refusal.ts";
import {mountPicker, type PickerView, withRefusal} from "./view.ts";

export interface PickerOptions {
	/** The process every program the picker opens is spawned under — the shell's own. */
	readonly shellProcessId: ProcessId;
	/**
	 * The view a refusal is written back over. The picker route passes its live view so a refused
	 * choice leaves the highlight where the user put it; the command line has none and omits it.
	 */
	readonly view?: PickerView;
}

/** A refusal reaches the user as the window's view: the picker is still mounted and re-renders. */
const refuse = (
	windowId: WindowId,
	options: PickerOptions,
	refusal: PickerRefusal,
): ReadonlyArray<ShellMsg> => [
	{type: "window.setView", windowId, view: withRefusal(options.view ?? mountPicker(), refusal)},
];

/**
 * The binding carries the row's key declaration: a window may only be sent a key its program asked
 * for, and this is the one place both are known at once (#7973).
 */
const bind = (
	windowId: WindowId,
	processId: ProcessId,
	row: AnyProgram,
): ReadonlyArray<ShellMsg> => [
	{type: "window.bind", windowId, processId, takesKeys: takesForwardedKeys(row)},
];

const open = Effect.fn("Tuval.Picker.open")(function* (
	windowId: WindowId,
	programId: ProgramId,
	options: PickerOptions,
) {
	const registry = yield* Registry;
	const processes = yield* Processes;

	const row = yield* Effect.result(registry.resolve(programId));
	if (row._tag === "Failure") return refuse(windowId, options, unknownProgram(programId));
	if (!showsInAWindow(row.success)) return refuse(windowId, options, programHeadless(programId));

	// Nothing ambient to give: a picker-opened process is not in the graph, so it comes back from a
	// checkpoint with no services either, and a program the picker may open must need none
	// (`.patterns/tuval-shell-assembly.md`). Said with `Context.empty()` rather than by omission —
	// the silent omission is what #7789 closed.
	const spawned = yield* Effect.result(
		processes.spawn(programId, {parent: options.shellProcessId, services: Context.empty()}),
	);
	return spawned._tag === "Failure"
		? refuse(windowId, options, spawnFailed(programId, spawned.failure.message))
		: bind(windowId, spawned.success.id, row.success);
});

const attach = Effect.fn("Tuval.Picker.attach")(function* (
	windowId: WindowId,
	processId: ProcessId,
	options: PickerOptions,
) {
	const table = yield* ProcessTable;
	const registry = yield* Registry;

	const row = yield* Effect.result(table.get(processId));
	if (row._tag === "Failure") return refuse(windowId, options, processGone(processId));

	// A running headless process has no renderer to mount, so binding it would blank the window.
	const program = yield* Effect.result(registry.resolve(row.success.programId));
	return program._tag === "Failure" || !showsInAWindow(program.success)
		? refuse(windowId, options, programHeadless(row.success.programId))
		: bind(windowId, processId, program.success);
});

/**
 * Run one intent. Both routes into this function — a chosen picker row, a resolved command line —
 * produce exactly one process for an open and exactly none for an attach.
 */
export const runPickerIntent = (
	intent: PickerIntent,
	options: PickerOptions,
): Effect.Effect<ReadonlyArray<ShellMsg>, never, Registry | Processes | ProcessTable> =>
	intent._tag === "OpenProgram"
		? open(intent.windowId, intent.programId, options)
		: attach(intent.windowId, intent.processId, options);
