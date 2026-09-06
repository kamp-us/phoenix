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

import type {AgentFailure, Phase} from "../events.ts";
import type {
	CommandRef,
	ItemId,
	Mode,
	ModelRef,
	PendingPermission,
	ThinkingLevel,
	TranscriptItem,
	TranscriptPayload,
	WindowOmission,
} from "../ports/index.ts";
import type {SendOutcome} from "./sends.ts";

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
 * What the session runs on, and what it may be switched to.
 *
 * `available` is the layer's *offered* set and never a backend's raw catalog: this state is
 * checkpointed whole, and Pi's runtime catalog is four figures at its pin — a checkpoint that grew
 * by it would be paying storage per session for a menu nobody can scroll (#7981).
 */
export interface ModelState {
	readonly current: ModelRef | null;
	readonly available: ReadonlyArray<ModelRef>;
}

/**
 * How hard this session thinks, and what it may be switched to. `available` is the layer's offered
 * set for the model it is running on, so a model switch can change it (#8062).
 */
export interface ThinkingState {
	readonly current: ThinkingLevel | null;
	readonly available: ReadonlyArray<ThinkingLevel>;
}

// A layer pushes one of these on the event stream too, so it is declared beside `Phase`.
export type {AgentFailure} from "../events.ts";

/**
 * An interruption the operator asked for and no backend event has answered yet (#8007).
 *
 * Asking is not stopping. The reducer used to walk the session to `ready` on the request itself,
 * which told the window the turn had stopped while the abort was still in flight — and re-armed the
 * composer for a prompt the backend was in no state to take. So the request records this instead
 * and the phase stays `prompting` until an event settles it.
 *
 * `requestedAt` is the operator's clock, carried on the Msg the way `prompt`'s timestamp is
 * (#7978): no update cell may read one, and the window needs it to say how long the request has
 * been outstanding rather than leaving a busy session unexplained.
 */
export interface Interruption {
	readonly requestedAt: number;
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
	/** An interruption asked for and not yet confirmed by an event; `null` when none is in flight. */
	readonly interruption: Interruption | null;
	readonly usage: UsageTotals;
	/**
	 * Pending permission cards by request id: one arrives with an event, and one leaves on the
	 * confirmation of its answer rather than on the click that answered it (#8006).
	 */
	readonly permissions: Readonly<Record<string, PendingPermission>>;
	/** How many cards this session has raised. Each entry's `seq` is stamped off it. */
	readonly permissionsRaised: number;
	readonly modes: ModeState;
	readonly models: ModelState;
	/**
	 * The slash commands this session offers the composer, whole (#8060). A flat list rather than a
	 * `current`/`available` pair like the two above: nothing selects a command, the picker inserts
	 * one as prompt text.
	 */
	readonly commands: ReadonlyArray<CommandRef>;
	readonly thinking: ThinkingState;
	/** The text of the last prompt sent, for the resend affordance. */
	readonly lastPrompt: string | null;
	/**
	 * What became of each deliberate send, under its own idempotency key (`./sends.ts`). The window
	 * that minted a key holds that send's text until this says the backend took it, which is what keeps
	 * a refused or unconfirmed prompt recoverable instead of cleared at dispatch.
	 */
	readonly sends: ReadonlyArray<SendOutcome>;
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

/**
 * Every field one checkpoint carries. Three things read it: the field-set test, which fails when a
 * new field lands here without anyone deciding it survives a restart, the defaults fill on the load
 * path (`snapshot.ts`), and a reader asking what a saved session is made of without walking the
 * machine.
 *
 * Nothing wire-shaped is in it. Each entry is plain JSON by construction — the type-level proof is
 * `boundary.unit.test.ts`, which reds when a service, a stream, an Effect or a closure reaches any
 * depth of the state — so the whole checkpoint round-trips through `JSON`.
 *
 * It lives in the core, and `../restore/checkpoint.ts` re-exports it under the address callers read
 * it by, for the reason `restoreSession` does: the core's import closure admits no sibling
 * directory, and the fill that walks this list is the machine's own `init` branch.
 */
export const checkpointFields = [
	"phase",
	"sessionId",
	"connection",
	"cwd",
	"transcript",
	"interrupted",
	"interruption",
	"usage",
	"permissions",
	"permissionsRaised",
	"modes",
	"models",
	"commands",
	"thinking",
	"lastPrompt",
	"sends",
	"lastPage",
	"failure",
] as const satisfies ReadonlyArray<keyof AiAgentSessionState>;

export type CheckpointField = (typeof checkpointFields)[number];

export const emptyOmission: WindowOmission = {items: 0, bytes: 0, reason: "none"};

export const emptyUsage: UsageTotals = {model: null, inputTokens: 0, outputTokens: 0, cost: 0};

export const initialState = (cwd: string): AiAgentSessionState => ({
	phase: "idle",
	sessionId: null,
	connection: 0,
	cwd,
	transcript: {items: [], omitted: emptyOmission},
	interrupted: null,
	interruption: null,
	usage: emptyUsage,
	permissions: {},
	permissionsRaised: 0,
	modes: {current: null, available: []},
	models: {current: null, available: []},
	commands: [],
	thinking: {current: null, available: []},
	lastPrompt: null,
	sends: [],
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

/** The cut-short turn, marked in the tail so a window renders the break off the transcript alone. */
const markInterrupted = (
	items: ReadonlyArray<TranscriptItem>,
	cut: ItemId | null,
): ReadonlyArray<TranscriptItem> =>
	cut === null
		? items
		: items.map((item) =>
				item.id === cut && item.kind === "assistant" ? {...item, interrupted: true} : item,
			);

/**
 * The checkpoint's parse boundary: what a saved session comes back as.
 *
 * A booted process holds no transport — the layer is built by the open, not by the spawn (ruling
 * 4, #7570) — so every phase but `gone` comes back `idle`, which is also the one phase a
 * `reconnect` is admissible from. `gone` stays `gone`: that session is over, and resuming it
 * anyway is the silent fresh session #7514 refuses.
 *
 * The saved phase is the whole interruption test. `prompting` means the layer never reported the
 * turn's `ready`, so the reply was still running when the process went away — whatever the tail
 * ends on, which is why a "does the tail end on an assistant item" predicate is the wrong reader:
 * a half-written assistant item reads as a completed reply to it.
 *
 * `failure`, `lastPage` and `interruption` are dropped. All three describe the run that ended: a
 * refusal nobody can act on any more, a page the window asked a transport that no longer exists
 * for, and an abort in flight to a backend this process no longer holds a transport to.
 *
 * A send still in flight comes back `uncertain` rather than dropped. The process went away between
 * handing the text to the layer and hearing what became of it, so nobody can say whether it landed
 * — and a window that reopens on this session offers its operator that text rather than resending
 * it.
 *
 * A card that was `answering` comes back `unresolved`. The call carrying that answer went with the
 * process, so whether the backend applied it is exactly what nobody knows — and an entry restored
 * to `open` would offer a second answer to an authorization that may already stand (#8006).
 *
 * Demlik's `init` may transform what the store loaded — that branch is the migration/parse hook —
 * but must emit no Cmds (`@demlik/tea` 0.12 `replay`, the "TEA contract violation" guard), so the
 * reconnect is a Msg the spawner dispatches (`../restore/checkpoint.ts`), never one scheduled here.
 */
export const restore = (loaded: AiAgentSessionState): AiAgentSessionState => {
	const cut = loaded.phase === "prompting" ? lastAssistantId(loaded.transcript.items) : null;
	return {
		...loaded,
		phase: loaded.phase === "gone" ? "gone" : "idle",
		transcript: {...loaded.transcript, items: markInterrupted(loaded.transcript.items, cut)},
		interrupted: cut ?? loaded.interrupted,
		interruption: null,
		sends: loaded.sends.map((send) =>
			send.state === "pending" ? {key: send.key, state: "uncertain", failure: null} : send,
		),
		permissions: Object.fromEntries(
			Object.entries(loaded.permissions).map(([id, held]) => [
				id,
				held.progress.status === "answering"
					? {...held, progress: {status: "unresolved", decision: held.progress.decision} as const}
					: held,
			]),
		),
		lastPage: null,
		failure: null,
	};
};
