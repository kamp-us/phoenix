/**
 * The session-list window as a page's renderer table imports it. Importing this pulls React and
 * `@kampus/design`, and nothing of a backend's wire: no `node:*`, no session store, no `../backends.ts`.
 *
 * The name the row declares lives one directory up (`../renderer-ref.ts`) and is re-exported here,
 * so a page reads the reference and the renderer from one import while the kernel-side row still
 * reaches none of this.
 */

export {AI_AGENT_INSPECTOR_REF, SESSION_LIST_WINDOW_REF} from "../renderer-ref.ts";
export {
	AiAgentInspector,
	AiAgentInspectorPanel,
	inspectorRows,
} from "./AiAgentInspector.tsx";
export {
	listView,
	type OpenPhase,
	type OpenRequest,
	type OpenTarget,
	openRead,
	type SendPlan,
	type SessionListView,
	type SessionSpawn,
	send,
	sessionView,
	TRANSCRIPT_PAGE_SIZE,
	type TranscriptRead,
} from "./opening.ts";
export {
	lastModifiedLabel,
	matchesQuery,
	NO_FIRST_PROMPT,
	newestFirst,
	rowValue,
	sessionDescription,
	sessionItem,
	sessionItems,
} from "./rows.ts";
export {
	SessionList,
	type SessionListProps,
	type SessionListSource,
	SessionListWindow,
	type SessionListWindowOptions,
	sessionListWindow,
	type TranscriptSource,
} from "./SessionListWindow.tsx";
export {
	type SessionTranscriptProps,
	SessionTranscriptView,
	type TranscriptAnswer,
} from "./SessionTranscript.tsx";
