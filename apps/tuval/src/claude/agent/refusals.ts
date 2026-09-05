/**
 * Every way this layer refuses, as the generic errors the core already folds.
 *
 * The SDK throws plain `Error`s, so each of these is a reading of one: the shipped errors are the
 * six in `ai-agent/service/errors.ts` and no Claude-shaped failure crosses the seam.
 */

import {PageError, PromptError, StartError, TransportError} from "../../ai-agent/service/index.ts";

/** What a thrown value says, without a stack and without assuming it is an `Error`. */
export const detailOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * A resume whose session the store does not hold.
 *
 * `getSessionMessages` "returns Array of messages, or empty array if session not found"
 * (`sdk.d.ts`), so an empty read for a session the caller named is the miss itself — no error text
 * to scrape, and no `query()` opened against a session that is not there.
 */
export const sessionNotFound = (cwd: string, resume: string): StartError =>
	new StartError({
		reason: "session-not-found",
		cwd,
		detail: `no session "${resume}" is stored for this working directory`,
	});

export const startTransport = (cwd: string, cause: unknown): StartError =>
	new StartError({reason: "transport", cwd, detail: detailOf(cause)});

/** The session ended before it said which session it was, so there is nothing to hand back. */
export const startWithoutInit = (cwd: string, detail: string): StartError =>
	new StartError({reason: "transport", cwd, detail});

export const noSession = (): PromptError =>
	new PromptError({
		reason: "no-session",
		detail: "start has not opened a Claude session on this layer",
	});

export const promptDisconnected = (cause: unknown): PromptError =>
	new PromptError({reason: "disconnected", detail: detailOf(cause)});

export const storeUnreadable = (cause: unknown): PageError =>
	new PageError({reason: "store-unreadable", detail: detailOf(cause)});

export const noSessionToPage = (): PageError =>
	new PageError({
		reason: "store-unreadable",
		detail: "start has not opened a Claude session on this layer",
	});

export const unknownCursor = (reason: string): PageError =>
	new PageError({reason: "unknown-cursor", detail: reason});

/** The subprocess went away. `no automatic respawn` is the whole retry policy (#7371). */
export const subprocessGone = (detail: string): TransportError =>
	new TransportError({reason: "disconnected", detail});

/** The async iterator itself threw, which is the transport failing rather than the session ending. */
export const streamFailed = (cause: unknown): TransportError =>
	new TransportError({reason: "protocol", detail: detailOf(cause)});

/**
 * A control request the CLI would not take. It never reaches the caller — `interrupt` and `setMode`
 * declare no channel for it — so it exists to keep the log line's cause typed rather than `unknown`.
 */
export const controlRefused = (cause: unknown): TransportError =>
	new TransportError({reason: "refused", detail: detailOf(cause)});
