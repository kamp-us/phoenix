/**
 * The prompts an operator wrote while a turn was running, waiting for that turn to end.
 *
 * A composer that offers a "queue" button and a core that refuses every prompt outside `ready` were
 * two halves of one lie: the send was logged as queued, refused as data, and the operator's words
 * appeared in no transcript and no queue (#8159). A queued prompt is session state rather than a
 * view's optimism, so both windows over one process see the same queue and a checkpoint carries it.
 *
 * It is deliberately *not* a transcript item. Nothing has been sent, and a tail that showed it would
 * be claiming a turn the backend has never heard of; the item lands the moment the queue flushes,
 * through the same `promptItem` every deliberate send goes through.
 *
 * See ADR 0357 (`.decisions/0357-tuval-prompts-queue-during-turn.md`).
 *
 * The queue flushes on exactly one event — the running turn's own end. Anything else that breaks
 * that continuity releases what is queued back to the operator as an unsent send (`./sends.ts`), so
 * one recovery path covers a refused prompt and an abandoned queue alike.
 */

import type {AgentFailure} from "../events.ts";
import {noteSend, type SendOutcome} from "./sends.ts";

/** One prompt waiting its turn, carrying everything its admission will need. */
export interface QueuedPrompt {
	readonly key: string;
	readonly text: string;
	readonly timestamp: number;
}

/**
 * How many prompts may wait at once. Reaching it refuses the newest rather than evicting the
 * oldest: a queue that silently drops what an operator already wrote is the bug this module exists
 * to fix, and a refusal is recoverable — it reaches the window as an unsent message.
 */
export const queueLimit = 5;

export const isQueueFull = (queued: ReadonlyArray<QueuedPrompt>): boolean =>
	queued.length >= queueLimit;

export const enqueue = (
	queued: ReadonlyArray<QueuedPrompt>,
	prompt: QueuedPrompt,
): ReadonlyArray<QueuedPrompt> => [...queued, prompt];

/**
 * Hand every queued prompt back to the window that wrote it, as a send that never crossed.
 *
 * `refused` and not `uncertain`: the text was never handed to a layer, so "it might have run" is
 * not one of the things nobody knows about it. The window is already holding each key's copy
 * (`shell/chat/outgoing.ts`), so this is what turns an abandoned queue into a Restore rather than
 * into silence.
 */
export const releaseQueued = (
	queued: ReadonlyArray<QueuedPrompt>,
	sends: ReadonlyArray<SendOutcome>,
	failure: AgentFailure,
): ReadonlyArray<SendOutcome> =>
	queued.reduce(
		(carried, prompt) => noteSend(carried, {key: prompt.key, state: "refused", failure}),
		sends,
	);
