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
	SubagentSlot,
	ThinkingLevel,
	TranscriptItem,
	TranscriptPayload,
	WindowOmission,
} from "../ports/index.ts";
import {promptUnqueued} from "./failures.ts";
import {type QueuedPrompt, releaseQueued} from "./queue.ts";
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
	/**
	 * The prompts written while the turn was running, in the order they were written (`./queue.ts`).
	 * The head is admitted when the turn ends; nothing here has been sent, so nothing here is in the
	 * transcript yet.
	 */
	readonly queued: ReadonlyArray<QueuedPrompt>;
	/** The last page `page` asked for and `paged` delivered. Not part of the live tail. */
	readonly lastPage: HistoryPage | null;
	/**
	 * The subagents this agent has spawned, by the id each is keyed on (`../ports/subagent.ts`).
	 *
	 * A record rather than a list because every update is an upsert under the spawning call's id,
	 * and the window's own order is `startedAt`, which each slot carries — so nothing here depends
	 * on key order. A finished slot stays: its rows are the view an operator may still be reading
	 * (Q9 on #8384).
	 */
	readonly subagents: Readonly<Record<string, SubagentSlot>>;
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
	"queued",
	"lastPage",
	// Decided to survive a restart: a subagent's rows are the whole view Q7 switches to, and they
	// live nowhere else this process can read — the parent's checkpoint is the only carrier (the
	// backend's own store answers for the agent's transcript, not for a worker's subtree). What a
	// restart does change is liveness: `restore` brings every slot back finished.
	"subagents",
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
	queued: [],
	lastPage: null,
	subagents: {},
	failure: null,
});

/**
 * Is any item in the tail still being written?
 *
 * The predicate a program hands the host as `checkpointWorthy`. A partial item is one frame of a
 * reply, superseded by the next delta — saving one writes the transcript per delta and, worse,
 * leaves a half-written reply as *the* reply when a stop lands mid-turn and the session is
 * restored from it (#8160's own no-go).
 *
 * Read through `in` rather than off the assistant kind: the marker is on that kind alone today, and
 * a second kind growing one (#8188, the thinking half) must not need this predicate edited to keep
 * its partials out of the store.
 */
export const holdsPartialItem = (state: AiAgentSessionState): boolean =>
	state.transcript.items.some((item) => "partial" in item && item.partial === true);

const settledItem = (item: TranscriptItem): TranscriptItem => {
	if (!("partial" in item) || item.partial !== true) return item;
	const {partial: _written, ...settled} = item;
	return settled;
};

/**
 * Take the streaming marker off every item still wearing one, keeping the text already written.
 *
 * A partial is superseded by the frame after it, and the upsert a layer sends at the end of a turn
 * is what drops the last marker (`../../claude/history/map.ts`). A turn that errors and a stream
 * that dies both end without that upsert — and the marker they strand makes `holdsPartialItem`
 * true for *every* later state of the session, so nothing is ever checkpointed again and the
 * session's copy on disk freezes at the last save before the stream (#8170, criterion 7). Settling
 * rather than dropping: what streamed is what the operator read, and the cut is already carried by
 * `interrupted` and `interruption`.
 */
export const settlePartialItems = (state: AiAgentSessionState): AiAgentSessionState =>
	holdsPartialItem(state)
		? {
				...state,
				transcript: {...state.transcript, items: state.transcript.items.map(settledItem)},
			}
		: state;

/** Is any subagent still writing? Its slot moves on every line the worker produces. */
export const holdsRunningSubagent = (state: AiAgentSessionState): boolean =>
	Object.values(state.subagents).some((slot) => slot.status === "running");

/**
 * Mark every running subagent finished, keeping its rows.
 *
 * A worker runs inside its parent's turn, so the turn ending is the worker ending — whatever the
 * turn came to. Without this a slot the layer never closed stays `running` for the rest of the
 * process, and the gate below then refuses every later state of the session, freezing its copy on
 * disk exactly as a stranded partial item did (#8170).
 */
export const settleRunningSubagents = (state: AiAgentSessionState): AiAgentSessionState =>
	holdsRunningSubagent(state)
		? {
				...state,
				subagents: Object.fromEntries(
					Object.entries(state.subagents).map(([id, slot]) => [
						id,
						slot.status === "running" ? {...slot, status: "finished" as const} : slot,
					]),
				),
			}
		: state;

/** Everything a turn's end settles: the reply still being written, and the workers under it. */
export const settleTurn = (state: AiAgentSessionState): AiAgentSessionState =>
	settleRunningSubagents(settlePartialItems(state));

/**
 * Is this state worth a checkpoint write? The predicate a program hands the host (`../program.ts`).
 *
 * Both arms are the same rule read over two fields: a value that is superseded by the next frame
 * costs a write per frame and, saved, freezes a mid-flight reading as the final one. A running
 * subagent's slot is such a value — its last line and its token count move on every nested line the
 * worker writes, which at the founder's concurrency is the busiest thing in the state. So the
 * coalescing #8160 built is extended here rather than joined by a second throttle: one predicate,
 * two reasons a state is not yet settled.
 */
export const checkpointWorthy = (state: AiAgentSessionState): boolean =>
	!holdsPartialItem(state) && !holdsRunningSubagent(state);

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
 * A queued prompt does not come back queued. The turn it was waiting for ended with the process, so
 * there is nothing left to flush it, and it is released to its window as an unsent send the same way
 * an interrupted queue is — recoverable, never resent on the operator's behalf.
 *
 * A send still in flight comes back `uncertain` rather than dropped. The process went away between
 * handing the text to the layer and hearing what became of it, so nobody can say whether it landed
 * — and a window that reopens on this session offers its operator that text rather than resending
 * it.
 *
 * No subagent comes back running. Nothing is pumping one any more — the layer that was reading its
 * frames went with the process — so a row still claiming to be live is a lie the operator cannot
 * clear, and it would hold the checkpoint gate shut for the rest of the restored session. The rows
 * it collected stay, because that is the view Q9 refuses to blank under a reader.
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
		...settleRunningSubagents(loaded),
		phase: loaded.phase === "gone" ? "gone" : "idle",
		transcript: {...loaded.transcript, items: markInterrupted(loaded.transcript.items, cut)},
		interrupted: cut ?? loaded.interrupted,
		interruption: null,
		queued: [],
		sends: releaseQueued(
			loaded.queued,
			loaded.sends.map((send) =>
				send.state === "pending" ? {key: send.key, state: "uncertain", failure: null} : send,
			),
			promptUnqueued("the process went away before the turn it was waiting for ended"),
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
