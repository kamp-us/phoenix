/**
 * What can go wrong with the subprocess → the interface's per-method errors.
 *
 * Founder ruling 3 (#7570) keys an error class to the method that raises it and enumerates the
 * cases inside it, so this module is the whole translation and no `node:`/platform fault ever
 * reaches a caller of `TuvalAiAgent`.
 */

import type {AgentFailure} from "../../ai-agent/events.ts";
import {
	InterruptError,
	PageError,
	PromptError,
	StartError,
	TranscriptError,
	TransportError,
} from "../../ai-agent/service/index.ts";

/** A platform fault or a refusal, as the one sentence an error's `detail` carries. */
export const detailOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/** A launch that never produced an `init` line: no binary, no credentials, an immediate exit. */
export const startFailed = (cwd: string, detail: string): StartError =>
	new StartError({reason: "transport", cwd, detail});

/**
 * A resume whose conversation agy would not reopen. Distinguished from a plain launch failure
 * because `start({resume})` is the one call a window makes on a saved id, and "that session is
 * gone" is the answer it has to render differently from "agy would not start at all".
 */
export const resumeFailed = (cwd: string, conversationId: string, detail: string): StartError =>
	new StartError({
		reason: "session-not-found",
		cwd,
		detail: `agy did not reopen conversation ${conversationId}: ${detail}`,
	});

export const noSession = (): PromptError =>
	new PromptError({
		reason: "no-session",
		detail: "start has not opened an agy session on this layer",
	});

/** A turn this layer refused before it reached stdin — see `launch.ts`'s `promptLine`. */
export const malformedPrompt = (detail: string): PromptError =>
	new PromptError({reason: "refused", detail});

/**
 * The subprocess is gone, as the one failure that ends `events`.
 *
 * **An interrupt is indistinguishable from a timeout at this wire, and this is the mapping site
 * that says so.** `SIGINT` makes agy exit 1 after emitting a well-formed terminal `result` carrying
 * `status: "ERROR"` and `error: "timeout waiting for response"`; the `INTERRUPTED` status exists in
 * the binary as a string and never fires (ADR 0362). So nothing downstream can tell a stop the
 * operator asked for from a stall the model fell into — *except* this layer, which knows it sent
 * the signal, and that knowledge lives here and nowhere else. The `interrupted` flag is not
 * evidence about the wire; it is this process's own memory of what it did.
 */
export const processGone = (exitCode: number | null, interrupted: boolean): TransportError =>
	new TransportError({
		reason: "disconnected",
		detail: interrupted
			? `the agy subprocess ended after an interrupt (exit ${exitCode ?? "unknown"}); agy reports an interrupt as a timeout, so the terminal result reads "timeout waiting for response" either way`
			: `the agy subprocess exited with code ${exitCode ?? "unknown"}`,
	});

/**
 * A `SIGINT` the child would not take, as the plain failure the event stream carries (ADR 0356).
 *
 * The refused thing here is the *interrupt call* — the signal never left this process — which is a
 * different fact from the one `processGone` above reports, where the signal worked and the child is
 * gone. agy's wire answers nothing about either, so `turnRunning` is this layer's own memory of
 * having sent a turn and not yet seen its `result`, and it is the half the fold routes on.
 */
export const interruptFailureOf = (cause: unknown, turnRunning: boolean): AgentFailure => {
	const error = new InterruptError({
		reason: turnRunning ? "turn-running" : "no-live-turn",
		detail: `agy refused to interrupt the turn: ${detailOf(cause)}`,
	});
	return {tag: error._tag, reason: error.reason, detail: error.message};
};

export const historyUnreadable = (detail: string): PageError =>
	new PageError({reason: "store-unreadable", detail});

export const unknownCursor = (detail: string): PageError =>
	new PageError({reason: "unknown-cursor", detail});

/**
 * The three ways a *stored* conversation's transcript does not come back (#8233).
 *
 * `transcriptSessionMissing` is the one `historyUnreadable` above cannot say. `page` reads the log
 * of the conversation this layer already has open, so nothing on disk there is an empty history;
 * the store read is handed an id from outside, and a conversation directory that is nowhere is the
 * ordinary answer that the conversation is gone — which a caller must be able to tell from a store
 * it could not look in.
 */
export const transcriptSessionMissing = (sessionId: string): TranscriptError =>
	new TranscriptError({
		reason: "session-not-found",
		sessionId,
		detail: "agy's brain directory holds no conversation with this id",
	});

export const transcriptUnreadable = (sessionId: string, cause: unknown): TranscriptError =>
	new TranscriptError({reason: "store-unreadable", sessionId, detail: detailOf(cause)});

export const transcriptUnknownCursor = (sessionId: string, reason: string): TranscriptError =>
	new TranscriptError({reason: "unknown-cursor", sessionId, detail: reason});
