/**
 * The transcript bounds both AI agent programs share: the live-tail window, the page walk, and the
 * per-item tool output bound. Pure functions over the port item union — no Effect, no transport,
 * no model-specific type. `boundary.unit.test.ts` holds that closure.
 */

export {
	type CursorPosition,
	groupBytes,
	groupTranscript,
	itemBytes,
	locateCursor,
	type NonEmpty,
	type TranscriptGroup,
} from "./groups.ts";
export {withoutLocalEchoes} from "./local-turns.ts";
export {
	type PageOptions,
	planTranscriptPage,
	type TranscriptPage,
	type TranscriptPageResult,
} from "./page.ts";
export {isRefusal, type PlanRefusal} from "./refusal.ts";
export {boundToolOutput, droppedResultBytes, type RawToolItem} from "./tool-output.ts";
export {
	planTranscriptWindow,
	TRANSCRIPT_WINDOW_BYTE_LIMIT,
	TRANSCRIPT_WINDOW_ITEM_LIMIT,
	type TranscriptWindow,
	type TranscriptWindowResult,
	type WindowOptions,
} from "./window.ts";
