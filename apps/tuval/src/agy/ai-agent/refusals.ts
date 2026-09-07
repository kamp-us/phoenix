/**
 * What can go wrong with the subprocess → the interface's per-method errors.
 *
 * Founder ruling 3 (#7570) keys an error class to the method that raises it and enumerates the
 * cases inside it, so this module is the whole translation and no `node:`/platform fault ever
 * reaches a caller of `TuvalAiAgent`.
 */

import {PageError, PromptError, StartError, TransportError} from "../../ai-agent/service/index.ts";

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

export const historyUnreadable = (detail: string): PageError =>
	new PageError({reason: "store-unreadable", detail});

export const unknownCursor = (detail: string): PageError =>
	new PageError({reason: "unknown-cursor", detail});
