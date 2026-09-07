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

import {randomUUID} from "node:crypto";
import {Context, Effect} from "effect";
import {SessionOpening} from "../../ai-agent/opening.ts";
import {NodeId} from "../../ports/graph.ts";
import {ProcessPorts, unwired} from "../../ports/ProcessPorts.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {type AnyProgram, type ProgramId, takesForwardedKeys} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import type {ShellMsg} from "../core/machine.ts";
import type {ViewState, WindowId} from "../window/host.ts";
import {showsInAWindow} from "./entries.ts";
import type {OpenSession, PickerIntent} from "./intent.ts";
import {
	type PickerRefusal,
	processGone,
	programHeadless,
	spawnFailed,
	unknownProgram,
} from "./refusal.ts";
import {asPickerView, withRefusal} from "./view.ts";

export interface PickerOptions {
	/** The process every program the picker opens is spawned under — the shell's own. */
	readonly shellProcessId: ProcessId;
	/**
	 * The window's own view slot, unnarrowed, as the state the Cmd left carries it (`../core/machine.ts`).
	 * A refusal is written back over it, so a refused choice keeps the highlight where the user put it
	 * and keeps the process `<c-b> w` left behind — otherwise the first refusal on a picker is what
	 * throws away the way back (#8265). The command line has no slot and omits it.
	 */
	readonly view?: ViewState;
}

/** A refusal reaches the user as the window's view: the picker is still mounted and re-renders. */
const refuse = (
	windowId: WindowId,
	options: PickerOptions,
	refusal: PickerRefusal,
): ReadonlyArray<ShellMsg> => [
	{type: "window.setView", windowId, view: withRefusal(asPickerView(options.view), refusal)},
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
	session: OpenSession | undefined,
) {
	const registry = yield* Registry;
	const processes = yield* Processes;

	const row = yield* Effect.result(registry.resolve(programId));
	if (row._tag === "Failure") return refuse(windowId, options, unknownProgram(programId));
	if (!showsInAWindow(row.success)) return refuse(windowId, options, programHeadless(programId));

	// A picker-opened program may require kernel services, and this is where they arrive: this
	// handler is sealed to the shell process's own spawn set, which is the kernel one `launch`
	// handed it (`src/boot.ts`), so `Effect.context()` reads exactly that and the child gets the
	// same. Passing the context on is the whole grant — a handler resolves its spawn set and
	// nothing else (#7972), so what is dropped here is dropped for good.
	//
	// `ProcessPorts` is the one thing dropped rather than passed: a port binding emits from *this*
	// node, so handing it down would send the child's payloads out of the shell's own ports. The
	// child gets one of its own below.
	const inherited = Context.omit(ProcessPorts)(yield* Effect.context());
	// Minted here rather than by `Processes.spawn` — same value, one call earlier — because the
	// ports below have to know which process they emit from.
	const id = ProcessId.make(randomUUID());
	// The child's own ports, put back after the omit above, the way `restore` puts one back
	// (`src/durability/restore.ts`). `unwired` because the graph owns no route to a picker-opened
	// process: an emit fails `PortNotWired` naming this child, where before the handler seal (#7972)
	// a row declaring `ProcessPorts` silently emitted out of the shell's.
	const opened = Context.add(inherited, ProcessPorts, unwired(NodeId.make(id)));
	// The one thing added rather than inherited. An open carrying a session is the first send on a
	// row the operator picked out of the session list, and the child has to come up resuming that
	// session instead of booting a second one beside it (epic #8070, ruling 2). The agent row's
	// `aiAgent.boot` handler is the only reader (`../../ai-agent/handlers/index.ts`).
	const services =
		session === undefined
			? opened
			: Context.add(opened, SessionOpening, {cwd: session.cwd, resume: session.resume});
	const spawned = yield* Effect.result(
		processes.spawn(programId, {id, parent: options.shellProcessId, services}),
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
		? open(intent.windowId, intent.programId, options, intent.session)
		: attach(intent.windowId, intent.processId, options);
