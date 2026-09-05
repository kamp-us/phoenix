/**
 * What became of each deliberate send, under the idempotency key its window minted.
 *
 * Three points in one send's life are three different facts, and collapsing them is what loses an
 * operator's text: the window dispatched it, the core admitted it, and the layer took it. The
 * `prompt` cell can refuse a send outright; the layer can refuse one the core admitted; and a
 * transport that dies mid-call leaves a send nobody can say either way about. Only the last of
 * those is `uncertain`, and it is the arm that must never resend on its own.
 *
 * The key is what makes an outcome a *particular* send's. Two windows over one process each mint
 * their own (#7570 ruling 2), so a refusal one of them earned cannot restore the other's text.
 */

import type {AgentFailure} from "../events.ts";
import {PROMPT_ERROR, START_ERROR, TRANSPORT_ERROR} from "./failures.ts";

export type SendOutcome =
	/** Admitted by the core and handed to the layer; nothing has come back yet. */
	| {readonly key: string; readonly state: "pending"}
	/** The layer took the text. The window may drop the copy it was holding. */
	| {readonly key: string; readonly state: "accepted"}
	/** Refused before the text crossed — it is recoverable, and it is not running anywhere. */
	| {readonly key: string; readonly state: "refused"; readonly failure: AgentFailure}
	/**
	 * The text may or may not have crossed. Recoverable exactly as a refusal is, and never resent
	 * automatically: a resend of a send that did land is a duplicate turn nobody asked for.
	 */
	| {readonly key: string; readonly state: "uncertain"; readonly failure: AgentFailure | null};

/**
 * How many outcomes one session keeps. At most one is `pending` — admission demands `ready` and
 * leaves the session `prompting` — so the rest are settled rows waiting for their window to read
 * them once, and a window reads on its next render. The bound exists because this list is
 * checkpointed with the rest of the state.
 */
export const sendLimit = 8;

/** Newest wins per key, newest last, bounded. */
export const noteSend = (
	sends: ReadonlyArray<SendOutcome>,
	outcome: SendOutcome,
): ReadonlyArray<SendOutcome> => {
	const kept = sends.filter((held) => held.key !== outcome.key);
	return [...kept, outcome].slice(-sendLimit);
};

export const sendOutcome = (sends: ReadonlyArray<SendOutcome>, key: string): SendOutcome | null =>
	sends.find((held) => held.key === key) ?? null;

export const pendingSend = (sends: ReadonlyArray<SendOutcome>): SendOutcome | null =>
	sends.find((held) => held.state === "pending") ?? null;

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

/** The send in flight is running somewhere: whatever happens to the turn now, the text landed. */
export const settleAccepted = (sends: ReadonlyArray<SendOutcome>): ReadonlyArray<SendOutcome> => {
	const pending = pendingSend(sends);
	return pending === null ? sends : noteSend(sends, {key: pending.key, state: "accepted"});
};

/**
 * Settle whatever send was in flight when something happened to the session as a whole — a
 * transport failure, a phase that went `gone`, a process that came back from a checkpoint. The
 * failure is not correlated to a key, but the send in flight is the only one it can be about.
 */
export const settlePending = (
	sends: ReadonlyArray<SendOutcome>,
	failure: AgentFailure | null,
): ReadonlyArray<SendOutcome> => {
	const pending = pendingSend(sends);
	if (pending === null) return sends;
	if (failure === null) return noteSend(sends, {key: pending.key, state: "uncertain", failure});
	return sendAfterFailure(failure) === null
		? sends
		: noteSend(sends, settledBy(pending.key, failure));
};
