/**
 * What one `ai-agent-session` holds, and what a checkpoint of it is.
 *
 * Every field is plain data: no service, no Effect value, no socket, no closure and no backend
 * wire type reaches it (#7371), which is what lets the whole state be written to a Demlik store
 * and read back. `boundary.unit.test.ts` proves that at the type level.
 *
 * The live tail is the only transcript the session keeps (#7569): older history is the backend's
 * store, read a page at a time, so `transcript` is whatever `planTranscriptWindow` last admitted
 * plus the running total of what the bounds dropped.
 */

import type {Phase} from "../events.ts";
import type {
	ItemId,
	Mode,
	PermissionRequest,
	TranscriptItem,
	TranscriptPayload,
	WindowOmission,
} from "../ports/index.ts";

/** Cumulative for the session: the core owns the running totals, the layer reports the deltas. */
export interface UsageTotals {
	/** The model the last usage event named, or `null` before any has arrived. */
	readonly model: string | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
}

export interface ModeState {
	readonly current: Mode | null;
	readonly available: ReadonlyArray<Mode>;
}

/**
 * The last thing that went wrong, as data. The layer's typed errors are classes; the core keeps
 * only the tag, the case and the detail, because the window renders by tag (ruling 3, #7570) and
 * a class instance is not something a checkpoint can carry.
 */
export interface AgentFailure {
	readonly tag: string;
	/** The error's own `reason` case, or `null` for an error class that enumerates none. */
	readonly reason: string | null;
	readonly detail: string;
}

/** One page of older history exactly as the backend returned it. Replaced, never accumulated. */
export interface HistoryPage {
	readonly items: ReadonlyArray<TranscriptItem>;
	readonly hasMore: boolean;
}

export interface AiAgentSessionState {
	readonly phase: Phase;
	/** The backend's session id once `start` answered; `null` before that and after a fresh start. */
	readonly sessionId: string | null;
	/**
	 * Which transport this session's live event stream belongs to. Every `started` mints the next
	 * one, so the events Sub's id changes on a reconnect and the host re-opens the stream against
	 * the rebuilt layer; keying the Sub on `sessionId` alone left a resumed session subscribed to
	 * the dead transport it had just replaced.
	 */
	readonly connection: number;
	readonly cwd: string;
	readonly transcript: TranscriptPayload;
	/** The assistant turn a restart cut short, so the window can offer the resend. */
	readonly interrupted: ItemId | null;
	readonly usage: UsageTotals;
	/** Pending permission cards by request id: one arrives with an event, one leaves with an answer. */
	readonly permissions: Readonly<Record<string, PermissionRequest>>;
	readonly modes: ModeState;
	/** The text of the last prompt sent, for the resend affordance. */
	readonly lastPrompt: string | null;
	/** The last page `page` asked for and `paged` delivered. Not part of the live tail. */
	readonly lastPage: HistoryPage | null;
	readonly failure: AgentFailure | null;
}

/**
 * Every `Phase`, as data a checkpoint can be read against. The type is the contract; this list is
 * the runtime half of it, and `state.unit.test.ts` pins that the two never diverge.
 */
export const phases = [
	"idle",
	"starting",
	"ready",
	"prompting",
	"reconnecting",
	"gone",
] as const satisfies ReadonlyArray<Phase>;

export const emptyOmission: WindowOmission = {items: 0, bytes: 0, reason: "none"};

export const emptyUsage: UsageTotals = {model: null, inputTokens: 0, outputTokens: 0, cost: 0};

export const initialState = (cwd: string): AiAgentSessionState => ({
	phase: "idle",
	sessionId: null,
	connection: 0,
	cwd,
	transcript: {items: [], omitted: emptyOmission},
	interrupted: null,
	usage: emptyUsage,
	permissions: {},
	modes: {current: null, available: []},
	lastPrompt: null,
	lastPage: null,
	failure: null,
});

/** The newest assistant turn in the tail, which is the one a restart can have cut. */
export const lastAssistantId = (items: ReadonlyArray<TranscriptItem>): ItemId | null => {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind === "assistant") return item.id;
	}
	return null;
};

/**
 * A reply landed only if the newest item is the assistant's. A tail ending on the operator's own
 * turn, or on a tool call, is a turn that was still running when the process went away.
 */
export const replyPending = (items: ReadonlyArray<TranscriptItem>): boolean =>
	items.length > 0 && items[items.length - 1]?.kind !== "assistant";

/**
 * The checkpoint's parse boundary: a state saved mid-turn comes back marked, not mid-turn.
 *
 * Demlik's `init` may transform what the store loaded — that branch is the migration/parse hook
 * — but must emit no Cmds (`@demlik/tea` 0.12 `replay`, the "TEA contract violation" guard), so
 * the reconnect itself is the host's `reconnect` Msg, never something this function schedules.
 */
export const restore = (loaded: AiAgentSessionState): AiAgentSessionState =>
	loaded.phase === "prompting" && replyPending(loaded.transcript.items)
		? {...loaded, phase: "reconnecting", interrupted: lastAssistantId(loaded.transcript.items)}
		: loaded;
