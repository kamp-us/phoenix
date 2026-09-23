/** The browser surface: the desk, its one keyboard listener, and the components it mounts. */

export {
	type ForwardedKey,
	ForwardedKeyProvider,
	useForwardedKey,
} from "@kampus/tuval-ui/forwarded-key";
export {
	INITIAL_INPUT_MODALITY,
	INPUT_MODALITY_ATTRIBUTE,
	type InputModality,
	inputModalityAround,
	inputModalityHandlers,
} from "@kampus/tuval-ui/input-modality";
export {
	type AttachEvent,
	type AttachState,
	type AttachStatus,
	attachInitial,
	type DeskSource,
	onAttachEvent,
	useDeskAttachment,
} from "./attach.ts";
export {CommandLine, type CommandLineProps} from "./CommandLine.tsx";
export {Desk, type DeskProps} from "./Desk.tsx";
export {DeskInspector, type DeskInspectorProps} from "./DeskInspector.tsx";
export {type DeskTables, deskSnapshotOf, noDeskTables} from "./desk-snapshot.ts";
export {ErrorBoundary, type ErrorBoundaryProps} from "./ErrorBoundary.tsx";
export {
	COMMAND_LINE_COMMAND,
	defaultLayoutOf,
	holdsPanels,
	panelWindows,
	routerPrefix,
	type StatusFrame,
	sameLayout,
	shellOwnsKey,
	statusFrame,
	zoomedWindow,
} from "./frame.ts";
export {LayoutView, type LayoutViewProps} from "./LayoutView.tsx";
export {
	boundMount,
	type MountResolver,
	noRenderer,
	type ProcessName,
	type ReactWindowRenderer,
	type WindowMount,
} from "./mount.ts";
export {PickerView, type PickerViewProps} from "./PickerView.tsx";
export {type KeyPress, type KeyReply, refused, replyIn, replyOf} from "./press.ts";
export {StatusLine, type StatusLineProps} from "./StatusLine.tsx";
export {WindowView, type WindowViewProps} from "./WindowView.tsx";
export {windowTitle} from "./window-title.ts";
