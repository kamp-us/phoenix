/**
 * The other end of the desk's removal affordance: `Processes.remove` called for one window, with
 * every way it refuses turned into the refusal that window already knows how to show (#9447).
 *
 * The refusals are the kernel's own and none of them is invented here. `ProcessIsPlanned` is the
 * graph-declared one, and the message it renders says to edit the config, because nothing done at
 * the desk outlives the next boot's `launch`. `ForgetRefused` is the durable write, and the process
 * it names is still running and still in the manifest, which is what makes it a refusal rather than
 * a warning. `ProcessNotFound` is `ProcessGone`, the arm the attach path already answers with for
 * the same fact.
 *
 * Nothing is asked before the call and no confirmation is modelled: the kernel refuses what it must
 * and otherwise acts, which is the shape `workspace.remove` has (`../core/machine.ts`).
 */

import type {RemoveError} from "@kampus/tuval-sdk/kernel/process/Processes";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import type {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import type {ViewState, WindowId} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {Effect, Predicate} from "effect";
import type {ShellMsg} from "../core/machine.ts";
import {refuse} from "./open.ts";
import {type PickerRefusal, processGone, processPlanned, removeFailed} from "./refusal.ts";

export interface ProcessRemovalOptions {
	/**
	 * The window's own view slot, unnarrowed, as the Cmd carries it. A refusal is written back over
	 * it, so the picker keeps the highlight and the process `<c-b> w` left behind — the same reason
	 * the open and attach handlers take one (`./open.ts`, #8265).
	 */
	readonly view?: ViewState;
}

/**
 * Why the durable half failed, as one line. `ForgetRefused.cause` is a `Schema.Defect`, so it is
 * `unknown` to the checker and its message is read rather than asserted — a store or manifest
 * failure carries one, and anything else is rendered as itself.
 */
const reasonOf = (cause: unknown): string =>
	Predicate.isObject(cause) && typeof cause.message === "string" ? cause.message : String(cause);

/**
 * One kernel refusal as the window's. A total switch, so a fourth `RemoveError` arm stops compiling
 * here rather than rendering as a process that is merely gone.
 */
const refusalOf = (processId: ProcessId, failure: RemoveError): PickerRefusal => {
	switch (failure._tag) {
		case "tuval/ProcessIsPlanned":
			return processPlanned(processId);
		case "tuval/ForgetRefused":
			return removeFailed(processId, reasonOf(failure.cause));
		case "tuval/ProcessNotFound":
			return processGone(processId);
	}
};

/**
 * Remove one process for one window. A success answers with no Msg at all: the row leaves the picker
 * because the process left the table, and the next snapshot carries that — there is no desk state to
 * write, which is why nothing here touches the view on the way through.
 */
export const runProcessRemoval = Effect.fn("Tuval.Picker.remove")(function* (
	windowId: WindowId,
	processId: ProcessId,
	options: ProcessRemovalOptions,
) {
	const processes = yield* Processes;
	const removed = yield* Effect.result(processes.remove(processId));
	return removed._tag === "Failure"
		? refuse(windowId, options.view, refusalOf(processId, removed.failure))
		: ([] as ReadonlyArray<ShellMsg>);
});
