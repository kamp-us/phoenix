/** The desk-level surfaces: the renderers a program declares, and how the shell composes them. */

export {
	type InspectorRegion,
	inspectorFor,
	type StatusBar,
	statusFor,
} from "./compose.ts";
export {
	type AnyInspectorRenderer,
	type AnyStatusRenderer,
	type InspectorRenderer,
	inspectorRenderer,
	type StatusRenderer,
	type StatusSegment,
	statusRenderer,
} from "./renderer.ts";
export type {
	DeclaredRenderers,
	DeskEmptyReason,
	DeskSnapshot,
	FocusedWindow,
	KernelFacts,
	SnapshotProcess,
} from "./snapshot.ts";
export {
	closeBoard,
	type DeskMsg,
	type DeskState,
	initialDesk,
	isDeskState,
	toggleBoard,
	toggleInspector,
} from "./state.ts";
