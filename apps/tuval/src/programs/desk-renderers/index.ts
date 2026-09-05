/**
 * The half of `engine-view`'s and `ps`'s desk renderers that is the same in both: the process facts
 * an inspector shows, the component that draws them, the hook that reads a selection off the window
 * contract, and the two segments both status renderers state. Each program keeps only what is its
 * own — where its selection lives, and the one extra segment it contributes.
 */

export {
	type NoSelection,
	noSelection,
	type PortLine,
	type ProcessDetail,
	type ProcessFacts,
	processDetail,
	type SelectionGone,
} from "./detail.ts";
export {ProcessDetailView, type ProcessDetailViewProps} from "./ProcessDetailView.tsx";
export {processCountSegment, selectedSegments} from "./segments.ts";
export {type SelectionReader, useSelectedProcessId} from "./selection.ts";
