/**
 * Why a choice did not open a window. Every arm is JSON, because a refusal is shown *in* the window
 * and the window's view slot is checkpointed JSON (`../window/host.ts`) — so a refusal rides the
 * transport and survives a restart the same way the rest of the desk does.
 *
 * Nothing here throws and nothing here is an Effect failure: `runPickerIntent` answers with a Msg
 * that puts one of these in the window, which is what "a typed refusal shown in the window" means.
 */

export type PickerRefusal =
	| {readonly _tag: "UnknownProgram"; readonly programId: string}
	| {readonly _tag: "ProgramHeadless"; readonly programId: string}
	| {readonly _tag: "ProcessGone"; readonly processId: string}
	| {readonly _tag: "SpawnFailed"; readonly programId: string; readonly reason: string}
	| {readonly _tag: "UnreadableCommand"; readonly line: string; readonly reason: string};

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
	}
};
