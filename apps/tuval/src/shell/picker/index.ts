/** The program picker: what an empty window shows, and the one handler both routes into it end in. */

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
export {type PickerOptions, runPickerIntent} from "./open.ts";
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
