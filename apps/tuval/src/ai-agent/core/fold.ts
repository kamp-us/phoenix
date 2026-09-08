/**
 * Folding one `AgentEvent` into the session state — the half of `update` that has nothing to do
 * with Cmds, kept apart so the transition table below reads as a table.
 *
 * The transcript half is the only one that can lose data, and it loses it on purpose: every new
 * item goes through `planTranscriptWindow`, so the tail in state is whatever the bounds admit and
 * the running omission totals carry what they dropped. A refused plan leaves the tail as it was —
 * the planner answers with data rather than throwing, so this does too.
 *
 * The transcript has one other entrance, and it is here too: the operator's own turn, recorded by
 * the `prompt` cell the moment they send it rather than when a layer gets round to echoing it
 * (#7978). That is the item `upsertItem`'s echo join exists for.
 */

import type {AgentEvent, AgentFailure, Phase} from "../events.ts";
import {isRefusal, planTranscriptWindow} from "../history/index.ts";
import {
	ItemId,
	type PendingPermission,
	type PermissionProgress,
	type TranscriptItem,
	type TranscriptPayload,
	type UserItem,
	type WindowOmission,
} from "../ports/index.ts";
import {INTERRUPT_ERROR, START_ERROR} from "./failures.ts";
import {markTurnRunning, settleAccepted, settleEndedSession, settleFailedTurn} from "./sends.ts";
import {
	type AiAgentSessionState,
	emptyOmission,
	lastAssistantId,
	settleTurn,
	type UsageLedger,
} from "./state.ts";

/** How much tail one session keeps. Absent, the window module's own defaults apply. */
export interface WindowLimits {
	readonly itemLimit?: number;
	readonly byteLimit?: number;
}

/** A locally-recorded turn's id, derived from the prompt's idempotency key so it is stable. */
export const promptItemId = (key: string): ItemId => ItemId.make(`local:${key}`);

/** The operator's turn as the core records it on send, before any layer has confirmed it. */
export const promptItem = (prompt: {
	readonly text: string;
	readonly key: string;
	readonly timestamp: number;
}): UserItem => ({
	kind: "user",
	id: promptItemId(prompt.key),
	timestamp: prompt.timestamp,
	text: prompt.text,
	local: true,
});

/**
 * Where a layer's echo of a locally-recorded turn belongs, or `-1`.
 *
 * Text is the only join the core has: the layer mints the turn under its own id, so an id lookup
 * would append the echo beside the item it is a copy of. Matching is confined to items still
 * carrying `local` — an echo that already landed cleared the flag — and a locally-recorded item
 * never reconciles against another one, so two deliberate sends of the same text stay two turns.
 */
const echoOf = (items: ReadonlyArray<TranscriptItem>, item: TranscriptItem): number =>
	item.kind !== "user" || item.local === true
		? -1
		: items.findIndex(
				(candidate) =>
					candidate.kind === "user" && candidate.local === true && candidate.text === item.text,
			);

/** An item with a known id supersedes the one it names, in place; anything else is the new tail. */
export const upsertItem = (
	items: ReadonlyArray<TranscriptItem>,
	item: TranscriptItem,
): ReadonlyArray<TranscriptItem> => {
	const byId = items.findIndex((candidate) => candidate.id === item.id);
	const at = byId < 0 ? echoOf(items, item) : byId;
	return at < 0
		? [...items, item]
		: items.map((candidate, index) => (index === at ? item : candidate));
};

const addOmission = (carried: WindowOmission, dropped: WindowOmission): WindowOmission => ({
	items: carried.items + dropped.items,
	bytes: carried.bytes + dropped.bytes,
	reason: dropped.reason === "none" ? carried.reason : dropped.reason,
});

export const foldItem = (
	transcript: TranscriptPayload,
	item: TranscriptItem,
	limits: WindowLimits,
): TranscriptPayload => {
	const planned = planTranscriptWindow(upsertItem(transcript.items, item), limits);
	return isRefusal(planned)
		? transcript
		: {items: planned.items, omitted: addOmission(transcript.omitted, planned.omitted)};
};

/**
 * One turn's cost, folded under that turn's own id.
 *
 * A turn already in the ledger keeps the entry it has: the event is the backend restating what
 * that turn cost, which a resume does routinely, and adding it a second time is the double-count
 * #8369 closed. The model is not keyed — it is whatever the newest report named, which is what the
 * inspector's model line has always shown.
 */
export const addUsage = (
	usage: UsageLedger,
	event: Extract<AgentEvent, {kind: "usage"}>,
): UsageLedger => ({
	model: event.model,
	turns:
		usage.turns[event.turn] === undefined
			? {
					...usage.turns,
					[event.turn]: {
						inputTokens: event.inputTokens,
						outputTokens: event.outputTokens,
						cost: event.cost,
					},
				}
			: usage.turns,
});

const without = <A>(
	pending: Readonly<Record<string, A>>,
	request: string,
): Readonly<Record<string, A>> =>
	Object.fromEntries(Object.entries(pending).filter(([id]) => id !== request));

export const dropRequest = (state: AiAgentSessionState, request: string): AiAgentSessionState => ({
	...state,
	permissions: without(state.permissions, request),
});

/** A card whose answer is out. The narrowing is what lets a caller read the decision unguarded. */
export type AnsweringPermission = PendingPermission & {
	readonly progress: Extract<PermissionProgress, {readonly status: "answering"}>;
};

/**
 * The card one answer's confirmation belongs to, or `null` when it belongs to nothing any more.
 *
 * Both operands have to match: the id says which card, and the `seq` says which *raising* of that
 * id. A reply that outlived its own card is stale, and clearing whatever sits under the id would
 * settle a request nobody has answered.
 */
export const awaitingAnswer = (
	state: AiAgentSessionState,
	request: string,
	seq: number,
): AnsweringPermission | null => {
	const held = state.permissions[request];
	if (held === undefined || held.seq !== seq) return null;
	return held.progress.status === "answering" ? {...held, progress: held.progress} : null;
};

/** The card as it stands once its answer's outcome turns out to be unknown. */
export const unresolvedAnswer = (
	state: AiAgentSessionState,
	request: string,
	held: AnsweringPermission,
): AiAgentSessionState => ({
	...state,
	permissions: {
		...state.permissions,
		[request]: {...held, progress: {status: "unresolved", decision: held.progress.decision}},
	},
});

/**
 * The two phases only the core's own cells may enter. `start` and `reconnect` are what put a
 * session into an open, and `started` or `failed` are the only ways out of one, so a layer cannot
 * tell the core about an open the core did not start.
 *
 * Every layer narrates its own open on the event stream — `PiAiAgent.start` and
 * `ClaudeAiAgent.start` both emit `starting` and then `ready` — and that stream is opened by the
 * `started` the open already answered (`machine.ts`, `subscriptions`). So the `starting` a Sub
 * reads first is always a report about an open that is finished, and folding it walks a ready
 * session backwards into a phase that refuses every prompt (#7925).
 */
const coreOwned = (phase: Phase): boolean => phase === "starting" || phase === "reconnecting";

/** The backend does not hold the session this resume named. */
const sessionGone = (failure: AgentFailure): boolean =>
	failure.tag === START_ERROR && failure.reason === "session-not-found";

/**
 * What is left of an outstanding interruption once the session lands on `phase`.
 *
 * The request is a question — "has the turn stopped?" — and the session leaving `prompting` is the
 * backend's answer, whichever way it left: a turn that ended, one that failed, a transport that
 * went away. While the session is still on the turn the question stands, which is what keeps the
 * window able to say the abort is outstanding rather than showing an unexplained busy line (#8007).
 */
export const interruptionAfter = (
	state: AiAgentSessionState,
	phase: AiAgentSessionState["phase"],
): AiAgentSessionState["interruption"] => (phase === "prompting" ? state.interruption : null);

/**
 * Where a failure leaves a session: back where it was before the act that failed.
 *
 * A resume is the exception, because there is nowhere before it to go back to. A refused resume
 * ends the session at `gone` — the id the checkpoint carried names nothing the backend still
 * holds, and the one thing that must never happen is a fresh session opening quietly in its place
 * (#7514). Any other reconnect failure is a transport that can be tried again, so it lands on
 * `idle` rather than staying at `reconnecting`, which the reconnect guard itself would refuse.
 */
export const phaseAfterFailure = (
	state: AiAgentSessionState,
	failure: AgentFailure,
): AiAgentSessionState["phase"] => {
	if (state.phase === "reconnecting") return sessionGone(failure) ? "gone" : "idle";
	if (state.phase === "starting") return "idle";
	if (state.phase === "prompting") return "ready";
	return state.phase;
};

/**
 * Where a refused interrupt leaves the session — the one failure `phaseAfterFailure` does not
 * decide (ADR 0356).
 *
 * `interrupt` declares no error channel, so a backend that will not stop reaches the core only as
 * this tag on the event stream, and routing it through the walk-to-`ready` above would say the turn
 * had stopped on the very event that says it has not. The `reason` the refusing adapter stamped is
 * the whole input, because it is the only party that knows which half it is on.
 *
 * `turn-running` changes nothing but the failure the window renders: the reply is still streaming,
 * so `settleTurn` is exactly wrong here — it would take the partial marker off a paragraph the
 * backend is still writing — and the outstanding `interruption` stays, since the operator's request
 * is answered rather than withdrawn.
 *
 * `no-live-turn` is the case that froze the founder's desk on 2026-09-05: there was nothing left to
 * stop, so the turn ends `interrupted` and the session goes to `ready` rather than sitting at
 * `prompting` until a restart. It reaches `ready` on the same terms the `phase` arm does and settles
 * the send the same way — the backend saying there is no turn to stop *is* that turn's end reported
 * late, and the send it belonged to has no other event coming to accept it. `settleFailedTurn` is
 * the wrong settle here and stays unused on both halves: this failure names the interrupt call
 * rather than a send, which is why `sendAfterFailure` (`./sends.ts`) answers `null` for the tag.
 */
export const foldInterruptRefusal = (
	state: AiAgentSessionState,
	failure: AgentFailure,
): AiAgentSessionState => {
	if (state.phase !== "prompting" || failure.reason === "turn-running") {
		return {...state, failure};
	}
	const turn = settleTurn(state);
	return {
		...turn,
		phase: "ready",
		interrupted: turn.interrupted ?? lastAssistantId(turn.transcript.items),
		interruption: null,
		failure,
		sends: settleAccepted(turn.sends),
	};
};

export const foldEvent = (
	state: AiAgentSessionState,
	event: AgentEvent,
	limits: WindowLimits,
): AiAgentSessionState => {
	switch (event.kind) {
		case "item":
			return {...state, transcript: foldItem(state.transcript, event.item, limits)};
		// The phase line is also where a send in flight learns it crossed, and it takes two events
		// to say so: the layer narrating the backend *starting* a turn, and then that turn ending.
		//
		// A layer's `prompt` returns at the send on both rows (#8018), so nothing on the Cmd's own
		// answer can say the backend took the text. Nor can a bare `ready`: the `prompt` cell walks
		// the session to `prompting` itself, before `aiAgent.prompt` is even called, so a `ready`
		// pushed for some earlier turn or for no turn at all lands in that gap looking exactly like
		// a turn's end (#8107). What is not ambiguous is the pair — `prompting` marks the send's
		// turn running (`./sends.ts`), and only a running turn's end accepts it, whatever the turn
		// itself came to, so its window may drop the copy it was holding (#8005). Both rows narrate
		// both halves: Pi off its session phase (`pi/ai-agent/items.ts` maps `idle` to `ready` and
		// everything else to `prompting`), the Claude layer on the write that hands the CLI the
		// text and on the SDK's `result` (`claude/agent/ClaudeAiAgent.ts`).
		//
		// The pair is also what says *which* send crossed, because a stale `ready` leaves the
		// session `ready` under a send whose turn never began and the operator can send again into
		// that gap — so two can be in flight at once. `markTurnRunning` gives the turn to the
		// oldest send still waiting for one, which is the order the layer handed them over in, and
		// `settleAccepted` reaches that running send and no other. Neither reads "whichever send is
		// pending", which is how a later turn accepted an older, never-started one (#8107).
		//
		// `gone` is the other half, and it is the terminal arm: a session that ended under a send in
		// flight can never answer for it, so `settleEndedSession` makes every one of them
		// recoverable. Refusals reach the send by their own arms below, and they arrive before this
		// line does — both rows push the turn's failure ahead of the phase that closes it.
		case "phase": {
			if (coreOwned(event.phase)) return state;
			// Any phase but `prompting` is the turn over, and nothing will supersede a partial the
			// stream left behind — least of all `gone`, which is the stream having died mid-reply.
			// A subagent under that turn is over with it, and settles here for the same reason.
			const turn = event.phase === "prompting" ? state : settleTurn(state);
			if (event.phase === "gone") {
				return {
					...turn,
					phase: event.phase,
					interruption: interruptionAfter(turn, event.phase),
					sends: settleEndedSession(turn.sends, null),
				};
			}
			return {
				...turn,
				phase: event.phase,
				interruption: interruptionAfter(turn, event.phase),
				sends:
					event.phase === "prompting" ? markTurnRunning(turn.sends) : settleAccepted(turn.sends),
			};
		}
		// A raising stamps the next `seq`, which is what makes a card's identity the raising rather
		// than the id: a backend that re-uses a request id gets a second card, and the first card's
		// answer can no longer settle it (#8006).
		case "permission": {
			const seq = state.permissionsRaised + 1;
			return {
				...state,
				permissionsRaised: seq,
				permissions: {
					...state.permissions,
					[event.request]: {request: event.detail, seq, progress: {status: "open"}},
				},
			};
		}
		case "permission-resolved":
			return dropRequest(state, event.request);
		case "mode":
			return {...state, modes: {current: event.current, available: event.available}};
		case "model":
			return {...state, models: {current: event.current, available: event.available}};
		// Replaced, never merged: the push carries the whole list, so a merge would keep a command
		// the backend has just withdrawn.
		case "commands":
			return {...state, commands: event.available};
		case "thinking":
			return {...state, thinking: {current: event.current, available: event.available}};
		// The turn's end and the swap in one commit, because the events Sub is keyed on the session
		// id and a second event under the old one would be filtered out (`../events.ts`).
		//
		// `ready` rather than a phase the layer narrates: a local command produces no `result`, so
		// this event is the only thing that will ever say the turn is over (#8197). The send that
		// asked for it is accepted on the same rule an ordinary turn's end uses — the oldest send
		// the layer said had begun, and no other (`./sends.ts`). What is queued is untouched here;
		// the machine's own `settleQueue` admits its head off the `ready`, so nothing an operator
		// wrote is dropped by the reset.
		//
		// Everything cleared belongs to the conversation that ended: its tail, its cut-turn marker,
		// the abort still outstanding over it, its permission cards — which no answer can reach any
		// more — its subagent rows and the page read off it. The usage ledger stays: the reset does
		// not un-spend what this session already spent.
		case "session-reset":
			return {
				...state,
				phase: "ready",
				sessionId: event.sessionId,
				transcript: {items: [], omitted: emptyOmission},
				interrupted: null,
				interruption: null,
				permissions: {},
				subagents: {},
				lastPage: null,
				pageOutcome: null,
				sends: settleAccepted(state.sends),
				failure: null,
			};
		case "usage":
			return {...state, usage: addUsage(state.usage, event)};
		// Replaced, never accumulated: one layer drives one backend, and the newest announcement is
		// what that backend is running.
		case "version":
			return {...state, agentVersion: event.version};
		// Replaced whole, never merged into the standing one: the layer resolves the account at the
		// open, so a field the newest announcement omits is a field this session does not have — and
		// a merge would keep the organization a previous login reported.
		case "account":
			return {...state, account: event.account};
		// Replaced under its own id, never merged: the mapper computes the whole slot from the
		// worker's frames, so a merge would keep a line the newer read has already superseded. A
		// finished slot is kept rather than dropped — its rows are a view an operator may be
		// reading (Q9, #8384).
		case "subagent":
			return {...state, subagents: {...state.subagents, [event.slot.id]: event.slot}};
		// The same landing the `failed` Msg gives a failure the handlers saw, so a refusal reads the
		// same to the window whichever channel carried it. Routing it through `event` is what keeps
		// the machine's identity filter over it: a late refusal from a session this process has
		// already replaced is dropped rather than failing its successor (#8018).
		//
		// This is the per-turn arm, not the terminal one: `phaseAfterFailure` can walk the session
		// back to `ready`, so `settleFailedTurn` settles the send this failure is about and leaves
		// every other in flight `pending` for its own turn's end (#8236).
		case "failure": {
			if (event.failure.tag === INTERRUPT_ERROR) {
				return foldInterruptRefusal(state, event.failure);
			}
			const phase = phaseAfterFailure(state, event.failure);
			const turn = settleTurn(state);
			return {
				...turn,
				phase,
				interruption: interruptionAfter(turn, phase),
				failure: event.failure,
				sends: settleFailedTurn(turn.sends, event.failure),
			};
		}
	}
};
