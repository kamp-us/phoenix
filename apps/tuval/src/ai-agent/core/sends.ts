/**
 * What became of each deliberate send, under the idempotency key its window minted.
 *
 * Four points in one send's life are four different facts, and collapsing them is what loses an
 * operator's text: the window dispatched it, the core admitted it, the layer took the handoff, and
 * the backend ran the turn. The `prompt` cell can refuse a send outright; the layer can refuse the
 * handoff; the backend can refuse a send the layer took, which reaches the core on the event stream
 * because both rows return from `prompt` at the send (#8018); and a transport that dies mid-call
 * leaves a send nobody can say either way about. Only the last of those is `uncertain`, and it is
 * the arm that must never resend on its own. The last point is itself two — a turn begun and a turn
 * ended — which is what `TurnProgress` below carries.
 *
 * The key is what makes an outcome a *particular* send's. Two windows over one process each mint
 * their own (#7570 ruling 2), so a refusal one of them earned cannot restore the other's text.
 */

import type {AgentFailure} from "../events.ts";
import {PROMPT_ERROR, START_ERROR, TRANSPORT_ERROR} from "./failures.ts";

/**
 * Whether any layer has yet narrated the backend *starting* the turn this send asked for.
 *
 * A send is admitted while the session is still `ready`, and the `prompt` cell walks the session to
 * `prompting` itself — so the core's own phase says nothing about the backend. Until a layer
 * narrates `prompting` on the event stream, the turn is `unstarted`, and a `ready` arriving in that
 * gap is about some earlier turn or about no turn at all (#8107).
 */
export type TurnProgress = "unstarted" | "running";

/**
 * Admitted by the core and handed to the layer; the backend has not answered yet. A `prompt` that
 * returned without refusing leaves a send right here, because on both rows it returns at the send
 * (#8018) — "the layer did not refuse the handoff" is not "the backend has the text".
 */
export type PendingSend = {
	readonly key: string;
	readonly state: "pending";
	readonly turn: TurnProgress;
};

export type SendOutcome =
	| PendingSend
	/** The backend ran the turn: the text crossed. The window may drop the copy it was holding. */
	| {readonly key: string; readonly state: "accepted"}
	/** Refused before the text crossed — it is recoverable, and it is not running anywhere. */
	| {readonly key: string; readonly state: "refused"; readonly failure: AgentFailure}
	/**
	 * The text may or may not have crossed. Recoverable exactly as a refusal is, and never resent
	 * automatically: a resend of a send that did land is a duplicate turn nobody asked for.
	 */
	| {readonly key: string; readonly state: "uncertain"; readonly failure: AgentFailure | null};

/**
 * How many outcomes one session keeps.
 *
 * **More than one can be `pending`, and more than one of those can have a `running` turn.** That is
 * not the invariant this module used to claim: a stale `ready` walks the session to `ready` under a
 * send whose turn never began, the composer is gated on the phase, so the operator sends again and
 * two are in flight at once (#8107). What holds instead is an *ordering*: the ledger keeps sends in
 * the order they were handed over, a session runs its turns in that order, and so the turn a layer
 * narrates beginning is the oldest send waiting for one and the turn it narrates ending is the
 * oldest one running. That order is what attributes a turn to a send; nothing here reads
 * "whichever send is in flight". The rest are settled rows waiting for their window to read them
 * once, and a window reads on its next render. The bound exists because this list is checkpointed
 * with the rest of the state.
 */
export const sendLimit = 8;

/**
 * One row per key, in the order the sends were admitted, bounded.
 *
 * A key already here is rewritten **in place**, and the position is load-bearing: it is the only
 * record of which send was handed over first, and the accept correlates a turn to a send by that
 * order. Appending the rewrite instead would walk a send's own row behind a later one every time
 * its turn changed state, and the ledger would then accept the wrong key (#8107).
 */
export const noteSend = (
	sends: ReadonlyArray<SendOutcome>,
	outcome: SendOutcome,
): ReadonlyArray<SendOutcome> => {
	const at = sends.findIndex((held) => held.key === outcome.key);
	return at < 0
		? [...sends, outcome].slice(-sendLimit)
		: sends.map((held, index) => (index === at ? outcome : held));
};

export const sendOutcome = (sends: ReadonlyArray<SendOutcome>, key: string): SendOutcome | null =>
	sends.find((held) => held.key === key) ?? null;

/** The oldest send still in flight, whatever its turn has come to. */
export const pendingSend = (sends: ReadonlyArray<SendOutcome>): PendingSend | null =>
	sends.find((held): held is PendingSend => held.state === "pending") ?? null;

/**
 * The oldest send whose turn a layer has narrated the backend running, or `null` — the send the
 * next turn's end belongs to.
 *
 * Oldest, because a layer can narrate two turns beginning before either ends: the Claude row
 * publishes its `prompting` at the send onto the same queue the turn's `ready` comes back on
 * (`claude/agent/ClaudeAiAgent.ts`), so a second send pushed under a live turn queues a second
 * `prompting` behind the first. The session still runs them in order, so the ends come back in that
 * order too, and taking the oldest running send is what pairs each end with its own beginning
 * (#8107).
 */
export const runningSend = (sends: ReadonlyArray<SendOutcome>): PendingSend | null =>
	sends.find((held): held is PendingSend => held.state === "pending" && held.turn === "running") ??
	null;

/** The oldest send the backend has not begun a turn for — the next turn's owner. */
const unstartedSend = (sends: ReadonlyArray<SendOutcome>): PendingSend | null =>
	sends.find(
		(held): held is PendingSend => held.state === "pending" && held.turn === "unstarted",
	) ?? null;

/**
 * Which arm a failure lands a send in, or `null` when the failure names some other call.
 *
 * `refused` is reserved for the cases the error's own `reason` proves the text never crossed —
 * `PromptError`'s `no-session` and `refused`, and a `StartError` that says this process holds no
 * session (`service/errors.ts` enumerates both sets). Everything else, a timeout and every
 * transport failure included, could have crossed, so it is `uncertain`: the cost of calling an
 * uncertain send refused is a duplicate turn, and the cost of the reverse is one extra button.
 *
 * A `ModeUnsupported`, a `ModelUnsupported`, an `UnknownRequest` or a `PageError` is about a
 * different call entirely and leaves a send in flight alone.
 *
 * `StartError`'s non-transport reasons read `refused` because a start that never opened is a start
 * no text crossed on — which is true of a *fresh* open and not, on its face, of a failed reconnect
 * under a live send. Ordering is what closes that: the disconnect a reconnect answers settles the
 * send `uncertain` before the reconnect is attempted, and `state.ts`'s `restore` maps a
 * checkpointed `pending` to `uncertain` for the same reason. A reconnect failure therefore never
 * meets a `pending` send.
 */
export const sendAfterFailure = (failure: AgentFailure): "refused" | "uncertain" | null => {
	if (failure.tag === PROMPT_ERROR) {
		return failure.reason === "no-session" || failure.reason === "refused"
			? "refused"
			: "uncertain";
	}
	if (failure.tag === START_ERROR) {
		return failure.reason === "transport" || failure.reason === "deadline"
			? "uncertain"
			: "refused";
	}
	return failure.tag === TRANSPORT_ERROR ? "uncertain" : null;
};

/** The same failure written against one send's key, on whichever arm that failure earns. */
export const settledBy = (key: string, failure: AgentFailure): SendOutcome =>
	sendAfterFailure(failure) === "refused"
		? {key, state: "refused", failure}
		: {key, state: "uncertain", failure};

/**
 * A layer narrated the backend starting a turn, so the oldest send it has not begun one for is the
 * turn it started.
 *
 * Order is the correlation. The layer hands sends over in the order the core admitted them and the
 * backend runs them in that order, so the next turn to begin belongs to the oldest send still
 * waiting for one — never to a later send that overtook it in the ledger.
 *
 * A turn already running does not stop this: a second `prompting` under a live turn is a second
 * send's, not the first one re-narrated, and refusing it there would leave that send `pending` with
 * no turn left to accept it on (#8107).
 */
export const markTurnRunning = (sends: ReadonlyArray<SendOutcome>): ReadonlyArray<SendOutcome> => {
	const next = unstartedSend(sends);
	return next === null ? sends : noteSend(sends, {...next, turn: "running"});
};

/**
 * The turn the send in flight asked for has ended: whatever became of it, the text crossed.
 *
 * A send whose turn no layer ever narrated starting is left `pending` instead. A phase is not a
 * confirmation, and both rows can push a `ready` that is about nothing this send asked for — Pi's
 * snapshot fan diffs against an empty projection, so its first snapshot emits `ready` off an `idle`
 * session whenever it lands, and the Claude layer's open emits one onto a queue whose subscriber
 * only opens afterwards. Either can arrive under a live send, and accepting on it would release the
 * window's held copy of text the backend has not seen (#8107).
 */
export const settleAccepted = (sends: ReadonlyArray<SendOutcome>): ReadonlyArray<SendOutcome> => {
	const running = runningSend(sends);
	return running === null ? sends : noteSend(sends, {key: running.key, state: "accepted"});
};

/**
 * Settle every send in flight when something happened to the session as a whole — a transport
 * failure, a phase that went `gone`, a process that came back from a checkpoint.
 *
 * The failure names no key, so the send it is about is the one whose turn was running, or the
 * oldest in flight when none had begun; that one takes the arm its `reason` earns. Every other send
 * in flight is `uncertain` instead: the session ended under a turn the backend never began for it,
 * and nothing here can say whether the text crossed — which is the recoverable arm that never
 * resends on its own. Leaving them `pending` is the alternative, and it strands them for ever,
 * because a settled session narrates no more turns to accept them on (#8107).
 */
export const settlePending = (
	sends: ReadonlyArray<SendOutcome>,
	failure: AgentFailure | null,
): ReadonlyArray<SendOutcome> => {
	if (failure !== null && sendAfterFailure(failure) === null) return sends;
	const named = runningSend(sends) ?? pendingSend(sends);
	if (named === null) return sends;
	return sends.map((held) => {
		if (held.state !== "pending") return held;
		return held.key === named.key && failure !== null
			? settledBy(held.key, failure)
			: {key: held.key, state: "uncertain", failure};
	});
};
