/**
 * The picker's browser half: the entries a window offers, the frame that describes them, the
 * intents a choice becomes, the refusals it can answer with, and the view it stores. Split from
 * `./index.ts` because that barrel also carries `./open.ts`, which reaches the kernel's `Processes`
 * and through it `node:crypto` — a surface importing the barrel for `noEntries` pulled the kernel
 * into its bundle and threw at module load (#7836).
 */

export {
	flatten,
	noEntries,
	type PickerEntries,
	type PickerEntry,
	type ProcessEntry,
	type ProgramEntry,
	processEntries,
	programEntries,
	readEntries,
	showsInAWindow,
} from "./entries.ts";
export {
	type PickerAnnouncement,
	type PickerFrame,
	type PickerFrameOptions,
	type PickerGroup,
	type PickerOption,
	type PickerTheme,
	pickerFrame,
} from "./frame.ts";
export {
	ATTACH_COMMAND,
	attachProcess,
	intentOf,
	OPEN_COMMAND,
	openProgram,
	type PickerCommand,
	type PickerIntent,
	pickerCommandFor,
	pickerCommands,
} from "./intent.ts";
export {
	isPickerRefusal,
	type PickerRefusal,
	processGone,
	programHeadless,
	refusalMessage,
	spawnFailed,
	unknownProgram,
	unreadableCommand,
} from "./refusal.ts";
export {
	cursorOf,
	highlighted,
	mountPicker,
	type PickerKeyAnswer,
	type PickerView,
	pickerKey,
	withRefusal,
} from "./view.ts";
