/** The browser surface: the desk, its one keyboard listener, and the components it mounts. */

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
export {ErrorBoundary, type ErrorBoundaryProps} from "./ErrorBoundary.tsx";
export {
	type ForwardedKey,
	ForwardedKeyProvider,
	useForwardedKey,
} from "./forwarded-key.tsx";
export {
	COMMAND_LINE_COMMAND,
	defaultLayoutOf,
	holdsPanels,
	panelWindows,
	routerPrefix,
	type StatusFrame,
	type SurfaceKeyAnswer,
	sameLayout,
	statusFrame,
	surfaceKey,
	zoomedWindow,
} from "./frame.ts";
export {LayoutView, type LayoutViewProps} from "./LayoutView.tsx";
export {
	boundMount,
	type MountResolver,
	noRenderer,
	type ReactWindowRenderer,
	type WindowMount,
} from "./mount.ts";
export {asPickerView, PickerView, type PickerViewProps} from "./PickerView.tsx";
export {StatusLine, type StatusLineProps} from "./StatusLine.tsx";
export {WindowView, type WindowViewProps} from "./WindowView.tsx";
