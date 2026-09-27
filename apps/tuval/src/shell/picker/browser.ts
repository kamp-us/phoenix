/**
 * The picker's browser half: the entries a window offers, the frame that describes them, the
 * intents a choice becomes, the refusals it can answer with, and the view it stores. Split from
 * `./index.ts` because that barrel also carries `./open.ts`, which reaches the kernel's `Processes`
 * and through it `node:crypto` — a surface importing the barrel for `noEntries` pulled the kernel
 * into its bundle and threw at module load (#7836).
 */

export {
	flatten,
	groupKeyOf,
	noEntries,
	type OfferedProgram,
	OPEN_PROJECT_ENTRY,
	type OpenProjectEntry,
	offerEntries,
	offeredOf,
	type PickerEntries,
	type PickerEntry,
	type PickerRow,
	type ProcessEntry,
	type ProgramEntry,
	processEntries,
	programEntries,
	readEntries,
	showsInAWindow,
} from "./entries.ts";
export {type PickerFilter, visibleEntries} from "./filter.ts";
export {
	type PickerAnnouncement,
	type PickerFilterFrame,
	type PickerFrame,
	type PickerFrameOptions,
	type PickerGroup,
	type PickerOption,
	type PickerTheme,
	pickerFrame,
	pickerTheme,
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
	browsing,
	LOADING,
	landedOn,
	type Opening,
	type OpenProjectAnswer,
	type OpenProjectFrameOptions,
	type OpenProjectRow,
	openProjectFrame,
	openProjectKey,
	openProjectPointer,
	recentFrom,
	type StepData,
	stepKey,
	stepRows,
	visibleStepRows,
} from "./open-project.ts";
export {
	asOpenProjectStep,
	browseStep,
	LAST_ROW,
	type OpenProjectStep,
	RECENT_STEP,
} from "./open-project-step.ts";
export {HOME_PLACE, placeName, type SessionPlace} from "./place.ts";
export {
	type ProjectOpener,
	ProjectOpenerFailure,
	projectOpenerOver,
} from "./project-opener.ts";
export {
	folderUnreadable,
	isPickerRefusal,
	type PickerRefusal,
	processGone,
	processPlanned,
	programHeadless,
	projectClosed,
	projectNotOpened,
	refusalMessage,
	removeFailed,
	spawnFailed,
	unknownProgram,
	unreadableCommand,
} from "./refusal.ts";
export {
	asPickerView,
	cursorOf,
	highlighted,
	mountPicker,
	noPickerKeyFeatures,
	type PickerKeyAnswer,
	type PickerKeyFeatures,
	type PickerLanding,
	type PickerPointer,
	type PickerView,
	pickerKey,
	pickerPointer,
	rowsFor,
	visibleFor,
	withFilter,
	withRefusal,
} from "./view.ts";
