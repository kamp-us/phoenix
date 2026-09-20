/**
 * Why the desk did not do what an empty window was asked for — open a program, attach a process, or
 * remove one. Every arm is JSON, because a refusal is shown *in* the window and the window's view
 * slot is checkpointed JSON (`../window/host.ts`) — so a refusal rides the transport and survives a
 * restart the same way the rest of the desk does.
 *
 * Nothing here throws and nothing here is an Effect failure: `runPickerIntent` (`./open.ts`) and
 * `runProcessRemoval` (`./remove.ts`) each answer with a Msg that puts one of these in the window,
 * which is what "a typed refusal shown in the window" means.
 *
 * The removal arms are the kernel's `RemoveError` (`../../process/errors.ts`) as a reader meets it,
 * one arm per refusal the kernel can answer with — except `ProcessNotFound`, which is `ProcessGone`
 * here, because "no live process has this id" is the one fact and the picker already says it.
 */

import {Predicate} from "effect";

export type PickerRefusal =
	| {readonly _tag: "UnknownProgram"; readonly programId: string}
	| {readonly _tag: "ProgramHeadless"; readonly programId: string}
	| {readonly _tag: "ProcessGone"; readonly processId: string}
	| {readonly _tag: "SpawnFailed"; readonly programId: string; readonly reason: string}
	| {readonly _tag: "UnreadableCommand"; readonly line: string; readonly reason: string}
	/** The kernel's `ProcessIsPlanned` (`../../process/errors.ts`) as the window announces it. */
	| {readonly _tag: "ProcessPlanned"; readonly processId: string}
	/** The kernel's `ForgetRefused`: the durable write failed, so the process is still in the picker. */
	| {readonly _tag: "RemoveFailed"; readonly processId: string; readonly reason: string};

export const unknownProgram = (programId: string): PickerRefusal => ({
	_tag: "UnknownProgram",
	programId,
});

export const programHeadless = (programId: string): PickerRefusal => ({
	_tag: "ProgramHeadless",
	programId,
});

export const processGone = (processId: string): PickerRefusal => ({_tag: "ProcessGone", processId});

export const spawnFailed = (programId: string, reason: string): PickerRefusal => ({
	_tag: "SpawnFailed",
	programId,
	reason,
});

export const unreadableCommand = (line: string, reason: string): PickerRefusal => ({
	_tag: "UnreadableCommand",
	line,
	reason,
});

export const processPlanned = (processId: string): PickerRefusal => ({
	_tag: "ProcessPlanned",
	processId,
});

export const removeFailed = (processId: string, reason: string): PickerRefusal => ({
	_tag: "RemoveFailed",
	processId,
	reason,
});

const strings = (value: Record<string, unknown>, fields: ReadonlyArray<string>): boolean =>
	fields.every((field) => typeof value[field] === "string");

/**
 * Is this a refusal? The slot a refusal lives in is checkpointed JSON that re-enters as `unknown`,
 * so the surface reading one back needs a guard rather than an assertion — the same reason the shell
 * state has `isShellState` (`../core/state.ts`). Total over the union, including each arm's fields:
 * an arm-shaped value missing a field would reach `refusalMessage` and render `undefined`.
 */
export const isPickerRefusal = (value: unknown): value is PickerRefusal => {
	if (!Predicate.isObject(value)) return false;
	switch (value._tag) {
		case "UnknownProgram":
		case "ProgramHeadless":
			return strings(value, ["programId"]);
		case "ProcessGone":
			return strings(value, ["processId"]);
		case "SpawnFailed":
			return strings(value, ["programId", "reason"]);
		case "UnreadableCommand":
			return strings(value, ["line", "reason"]);
		case "ProcessPlanned":
			return strings(value, ["processId"]);
		case "RemoveFailed":
			return strings(value, ["processId", "reason"]);
		default:
			return false;
	}
};

/**
 * The refusal as the window announces it. One function so the surface never composes its own
 * wording: the browser page reads this string into the picker's alert region, and a test reads the
 * same string.
 */
export const refusalMessage = (refusal: PickerRefusal): string => {
	switch (refusal._tag) {
		case "UnknownProgram":
			return `No program is registered under id "${refusal.programId}".`;
		case "ProgramHeadless":
			return `Program "${refusal.programId}" declares no renderer, so it cannot fill a window.`;
		case "ProcessGone":
			return `Process "${refusal.processId}" is no longer running.`;
		case "SpawnFailed":
			return `Program "${refusal.programId}" could not start: ${refusal.reason}`;
		case "UnreadableCommand":
			return `Cannot read "${refusal.line}": ${refusal.reason}`;
		case "ProcessPlanned":
			return `Process "${refusal.processId}" is declared by the config graph, so boot would start it again. Edit the config to remove it.`;
		case "RemoveFailed":
			return `Process "${refusal.processId}" was not removed and is still running: ${refusal.reason}`;
	}
};
