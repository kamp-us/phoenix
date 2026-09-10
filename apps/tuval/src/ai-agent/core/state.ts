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

import type {AgentAccount, AgentFailure, Phase} from "../events.ts";
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
	TurnResult,
	WindowOmission,
} from "../ports/index.ts";
import {promptUnqueued} from "./failures.ts";
import {type QueuedPrompt, releaseQueued} from "./queue.ts";
import type {SendOutcome} from "./sends.ts";

/** What one turn spent. No model of its own: the ledger holds the last one named. */
export interface TurnUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
}

/**
 * What the session has spent, under each turn's own id.
 *
 * Keyed rather than summed, and that is the whole point: a layer reports a turn's cost as a fact
 * about that turn, not as an increment, and it reports it again whenever a resume walks a
 * transcript this process has already folded (#8369). A running sum cannot tell that second report
 * from a second turn, so every path that resumes has to carry "already counted" correctly and
 * exactly one of them getting it wrong is a wrong number on the operator's screen. Under a key
 * there is nothing to carry: folding a turn already here is a no-op.
 *
 * The totals are derived (`usageTotals`) rather than stored beside this, so no total can disagree
 * with the turns it is a sum of.
 */
export interface UsageLedger {
	/** The model the last usage event named, or `null` before any has arrived. */
	readonly model: string | null;
	readonly turns: Readonly<Record<string, TurnUsage>>;
}

/** Cumulative for the session, as a window renders it: the ledger summed. */
export interface UsageTotals {
	readonly model: string | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
}

export const usageTotals = (usage: UsageLedger): UsageTotals =>
	Object.values(usage.turns).reduce<UsageTotals>(
		(totals, turn) => ({
			model: totals.model,
			inputTokens: totals.inputTokens + turn.inputTokens,
			outputTokens: totals.outputTokens + turn.outputTokens,
			cost: totals.cost + turn.cost,
		}),
		{model: usage.model, inputTokens: 0, outputTokens: 0, cost: 0},
	);

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

// A layer pushes one of these on the event stream too, so they are declared beside `Phase`.
export type {AgentAccount, AgentFailure} from "../events.ts";

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

export type PageOutcome =
	| {readonly status: "success"; readonly page: HistoryPage}
	| {readonly status: "refused"; readonly failure: AgentFailure};

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
	readonly usage: UsageLedger;
	/**
	 * The version of whatever the layer is driving, as that layer reports it — the Claude Code CLI
	 * for one row, Pi's adapter for the other — or `null` before any layer has said.
	 *
	 * Model-blind on purpose: it is one string nobody parses, so a second backend fills the same
	 * slot rather than growing its own. The point of showing it is drift (#7580), so it is rendered
	 * as the desk inspector's `Version` row (`../window/AiAgentInspector.tsx`) rather than living in
	 * the Claude layer's log line. What the Claude row reports is the CLI the Agent SDK bundles and
	 * launches, which is not necessarily the `claude` on `PATH`: the SDK spawns its own built-in
	 * executable unless `pathToClaudeCodeExecutable` names another (`sdk.d.ts` at the `0.3.259`
	 * pin), and this program never sets it — a desk on SDK `0.3.259` reported CLI `2.1.259` while
	 * `claude --version` on the same box read `2.1.263`.
	 */
	readonly agentVersion: string | null;
	/**
	 * The account this session booted on, as the layer reported it — or `null` for every way there
	 * is nothing to report: no layer has said yet, the layer has no account concept (Pi, Codex), or
	 * the login carries neither field (an API key, a third-party provider).
	 *
	 * Model-blind like `agentVersion` beside it, and it holds no email by construction: `AgentAccount`
	 * has no such field, so the founder's org-and-plan-only ruling is a shape here rather than a
	 * filter at the render (#8649).
	 */
	readonly account: AgentAccount | null;
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
	/** The page dispatch's completion observation; retained page/failure fields are not outcomes. */
	readonly pageOutcome: PageOutcome | null;
	/**
	 * The subagents this agent has spawned, by the id each is keyed on (`../ports/subagent.ts`).
	 *
	 * A record rather than a list because every update is an upsert under the spawning call's id,
	 * and the window's own order is `startedAt`, which each slot carries — so nothing here depends
	 * on key order. A finished slot stays: its rows are the view an operator may still be reading
	 * (Q9 on #8384).
	 */
	readonly subagents: Readonly<Record<string, SubagentSlot>>;
	/**
	 * What the last finished turn came to, or `null` before any turn has finished (#8724).
	 *
	 * Held rather than only published, so a window re-attaching to a running process is answered
	 * from the same slot the port is filled from — `republish` reads this, and a second copy
	 * computed at that moment would be a different answer to the same question.
	 */
	readonly result: TurnResult | null;
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
	"agentVersion",
	"account",
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
	"pageOutcome",
	// Decided to survive a restart: a subagent's rows are the whole view Q7 switches to, and they
	// live nowhere else this process can read — the parent's checkpoint is the only carrier (the
	// backend's own store answers for the agent's transcript, not for a worker's subtree). What a
	// restart does change is liveness: `restore` brings every slot back finished.
	"subagents",
	// Decided to survive a restart: it is a fact about a turn that finished, like the tail it
	// summarizes, and a consumer that reads the port after a restore is asking what this session
	// last answered — not what it answered since the process came back.
	"result",
	"failure",
] as const satisfies ReadonlyArray<keyof AiAgentSessionState>;

export type CheckpointField = (typeof checkpointFields)[number];

export const emptyOmission: WindowOmission = {items: 0, bytes: 0, reason: "none"};

export const emptyUsage: UsageLedger = {model: null, turns: {}};

export const initialState = (cwd: string): AiAgentSessionState => ({
	phase: "idle",
	sessionId: null,
	connection: 0,
	cwd,
	transcript: {items: [], omitted: emptyOmission},
	interrupted: null,
	interruption: null,
	usage: emptyUsage,
	agentVersion: null,
	account: null,
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
	pageOutcome: null,
	subagents: {},
	result: null,
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

/**
 * A worker this session is the one writing the lines of. A kernel child is not one: it is its own
 * process on the kernel's table, so nothing in this session moves its slot and this session's turn
 * ending says nothing about whether it is done (#8715).
 */
const ownWorker = (slot: SubagentSlot): boolean => slot.process === undefined;

/** Is any subagent still writing? Its slot moves on every line the worker produces. */
export const holdsRunningSubagent = (state: AiAgentSessionState): boolean =>
	Object.values(state.subagents).some((slot) => ownWorker(slot) && slot.status === "running");

/**
 * Mark every running worker of this session's own finished, keeping its rows. A kernel child is
 * left alone (`ownWorker`): its process outlives the turn that spawned it.
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
						ownWorker(slot) && slot.status === "running"
							? {...slot, status: "finished" as const}
							: slot,
					]),
				),
			}
		: state;

/** Everything a turn's end settles: the reply still being written, and the workers under it. */
export const settleTurn = (state: AiAgentSessionState): AiAgentSessionState =>
	settleRunningSubagents(settlePartialItems(state));

/**
 * A session at `gone` offers no rows: every catalog it read off that session is emptied, and the
 * operator's held picks stay.
 *
 * The four are session-owned and checkpointed, so without this they come back off disk intact and
 * `offerResolved` (`../../shell/chat/composer-bridge.ts`) paints them as a live offer on a window
 * whose session is over (#8634). The layer's own teardown clear is announced from
 * `ClaudeAiAgent.start` and only when a session was torn down in this process, so it reaches one
 * lifetime of three — a refused reconnect on a rebuilt layer, a checkpoint saved at `gone` and a
 * live process failing into `gone` all arrive here with no layer announcement behind them. Holding
 * the invariant in the core covers all three, and agrees with the layer rather than racing it.
 *
 * `current` is untouched on purpose: a pick is the operator's, not the session's, and the next open
 * re-validates it against the catalog it reads (#7981). `commands` has no selection to keep — the
 * picker inserts a command as prompt text — so it empties whole.
 */
export const closeOfferedCatalogs = (state: AiAgentSessionState): AiAgentSessionState => ({
	...state,
	modes: {current: state.modes.current, available: []},
	models: {current: state.models.current, available: []},
	commands: [],
	thinking: {current: state.thinking.current, available: []},
});

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

/**
 * The operator's prompt for the turn in flight: the row a cut turn's Resend is anchored on.
 *
 * The anchor is the prompt rather than the reply because Escape must always leave a way back, and
 * the reply is the one row that may not exist yet — or ever. A turn cut before the model wrote a
 * token has no assistant row at the press, and a turn whose content was tool calls alone draws none
 * at all (`../pi/items.ts` suppresses it), so an anchor read off the reply is missing in exactly the
 * case the operator stopped fastest (#8699). The prompt is in the tail from the send: the `prompt`
 * cell folds a local echo of it before the layer is called, and `planTranscriptWindow` admits the
 * newest turn's group whole whatever the bounds, so at `prompting` this answers.
 *
 * `null` therefore means the tail holds no prompt at all — no turn here to offer back.
 */
export const cutPromptId = (items: ReadonlyArray<TranscriptItem>): ItemId | null => {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind === "user") return item.id;
	}
	return null;
};

/**
 * The reply row of the turn in flight: the row a cut turn's "You stopped this response" fold label
 * is read off, once `markInterrupted` has flagged it.
 *
 * This names the *mark*, never the resend anchor — `cutPromptId` owns that. Scoped to the newest
 * `user` row deliberately: a turn whose content was tool calls alone draws no assistant row at all
 * (`../pi/items.ts` suppresses it), so a scan that walked past the operator's prompt would answer
 * with the *previous* turn's finished reply and badge it as cut short (#8216). `null` is still the
 * right answer there — that turn has no row to mark, and badging another turn's reply is the defect.
 * What `null` no longer costs is the resend, which rides the prompt and lands whether a reply does
 * or not.
 */
export const lastAssistantId = (items: ReadonlyArray<TranscriptItem>): ItemId | null => {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind === "user") return null;
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
 * `failure`, `lastPage`, `pageOutcome` and `interruption` are dropped. They describe the run that ended: a
 * refusal nobody can act on any more, a page the window asked a transport that no longer exists
 * for, and an abort in flight to a backend this process no longer holds a transport to.
 *
 * `agentVersion` is dropped for a narrower reason: it names the binary the *previous* process
 * drove, and a dependency update swaps the CLI the SDK bundles while the desk is off — which is the
 * exact drift the line exists to show (#7580). The layer re-reports it as this session opens, so
 * `null` for that gap says "nobody has told me yet" rather than showing a version nothing is
 * running.
 *
 * `account` is dropped on that same argument. It names the account the *previous* process booted
 * on, and the operator can log into another one while the desk is off — so a row still naming the
 * old account is exactly the wrong answer to "which of my two accounts is this billing" (#8649).
 * The layer re-announces as this session opens.
 *
 * A checkpoint saved at `gone` comes back with its catalogs emptied (`closeOfferedCatalogs`), and
 * one saved at any other phase keeps them: it comes back `idle`, where `offerResolved` is false, so
 * nothing paints them before the reconnect re-announces what this session offers.
 *
 * A queued prompt does not come back queued. The turn it was waiting for ended with the process, so
 * there is nothing left to flush it, and it is released to its window as an unsent send the same way
 * an interrupted queue is — recoverable, never resent on the operator's behalf.
 *
 * A send still in flight comes back `uncertain` rather than dropped — every one of them, because
 * this is a terminal settle like `gone`'s and not a per-turn failure (#8236). The process went away
 * between handing the text to the layer and hearing what became of it, so nobody can say whether it
 * landed — and a window that reopens on this session offers its operator that text rather than
 * resending it.
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
	const interrupted = loaded.phase === "prompting";
	// Two rows, one cut turn: the reply carries the mark its fold label is read off, the prompt
	// carries the resend — and a turn that wrote no reply has only the second of them (#8699).
	const reply = interrupted ? lastAssistantId(loaded.transcript.items) : null;
	const cut = interrupted ? cutPromptId(loaded.transcript.items) : null;
	const settled =
		loaded.phase === "gone"
			? closeOfferedCatalogs(settleRunningSubagents(loaded))
			: settleRunningSubagents(loaded);
	return {
		...settled,
		phase: loaded.phase === "gone" ? "gone" : "idle",
		transcript: {...loaded.transcript, items: markInterrupted(loaded.transcript.items, reply)},
		interrupted: cut ?? loaded.interrupted,
		interruption: null,
		agentVersion: null,
		account: null,
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
		pageOutcome: null,
		failure: null,
	};
};
