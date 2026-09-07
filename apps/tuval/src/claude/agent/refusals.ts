/**
 * Every way this layer refuses, as the generic errors the core already folds.
 *
 * The SDK throws plain `Error`s, so each of these is a reading of one: the shipped errors are the
 * six in `ai-agent/service/errors.ts` and no Claude-shaped failure crosses the seam.
 *
 * A thrown value's own text is not one of those readings (#8010). `handlers/failures.ts` copies
 * `error.message` into the `AgentFailure` the core checkpoints and the window renders, so SDK
 * exception text placed in `detail` becomes operator-facing copy nobody wrote. Each helper below
 * names the operation that failed, adds guidance only where `diagnose` has evidence for one, and
 * hands the thrown value to `retaining` — which parks it on the JS `cause` slot, outside the
 * schema, where this process can read it and the core's plain data cannot carry it.
 */

import {Effect} from "effect";
import type {AgentFailure} from "../../ai-agent/events.ts";
import {
	InterruptError,
	ListError,
	PageError,
	PromptError,
	StartError,
	TranscriptError,
	TransportError,
} from "../../ai-agent/service/index.ts";
import {diagnose} from "./diagnosis.ts";

const retaining = <E extends Error>(cause: unknown, error: E): E => {
	error.cause = cause;
	return error;
};

/** What the operator is told: the operation that failed, plus guidance where there is evidence. */
const translated = (operation: string, cause: unknown): string => {
	const known = diagnose(cause);
	return known === null ? operation : `${operation} — ${known}`;
};

/**
 * The local diagnostic line for a refusal the layer swallows rather than raises.
 *
 * The retained cause rides beside the deliberate message, which is why these callers no longer read
 * `detail` for the SDK's words: `detail` says what failed, the cause says why.
 */
export const logRefused = (what: string, refusal: Error & {readonly detail: string}) =>
	Effect.logWarning(`${what}: ${refusal.detail}`, refusal.cause);

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
	retaining(
		cause,
		new StartError({
			reason: "transport",
			cwd,
			detail: translated("the Claude Code CLI did not open a session here", cause),
		}),
	);

/**
 * The query ended before its `initialize` control request came back, so it never opened.
 *
 * That rejection is the SDK's own: tearing a query down rejects every pending control request with
 * "Query closed before response received" (`sdk.mjs`, `performCleanup`), and the handshake is one
 * of them.
 */
export const startWithoutHandshake = (cwd: string, cause: unknown): StartError =>
	retaining(
		cause,
		new StartError({
			reason: "transport",
			cwd,
			detail: translated(
				"the Claude Code CLI closed before it answered the connect handshake",
				cause,
			),
		}),
	);

export const noSession = (): PromptError =>
	new PromptError({
		reason: "no-session",
		detail: "start has not opened a Claude session on this layer",
	});

export const promptDisconnected = (cause: unknown): PromptError =>
	retaining(
		cause,
		new PromptError({
			reason: "disconnected",
			detail: translated("the Claude Code session did not take the message", cause),
		}),
	);

export const storeUnreadable = (cause: unknown): PageError =>
	retaining(
		cause,
		new PageError({
			reason: "store-unreadable",
			detail: translated("the Claude Code session store did not answer", cause),
		}),
	);

export const noSessionToPage = (): PageError =>
	new PageError({
		reason: "store-unreadable",
		detail: "start has not opened a Claude session on this layer",
	});

export const unknownCursor = (reason: string): PageError =>
	new PageError({reason: "unknown-cursor", detail: reason});

/**
 * The three ways a subagent's own transcript does not come back (#8404). None of them is an empty
 * transcript: a sidechain file nobody wrote, a store that would not open and a line that will not
 * parse are three different things to have to tell an operator, and "this subagent said nothing"
 * is none of them.
 *
 * `subagentNotFound` appends the id itself and is the only place that names it — a caller that
 * spells it in its own `detail` says it twice.
 */
export const subagentNotFound = (agentId: string, detail: string): PageError =>
	new PageError({reason: "subagent-not-found", detail: `${detail} (${agentId})`});

export const subagentStoreUnreadable = (cause: unknown): PageError =>
	retaining(
		cause,
		new PageError({
			reason: "store-unreadable",
			detail: translated(
				"the Claude Code session store did not answer this subagent's transcript",
				cause,
			),
		}),
	);

export const subagentMalformed = (agentId: string, line: number, detail: string): PageError =>
	new PageError({
		reason: "subagent-malformed",
		detail: `subagent "${agentId}" line ${line}: ${detail}`,
	});

/**
 * The three ways a *stored* session's transcript does not come back (#8233).
 *
 * `transcriptSessionNotFound` is the reading `sessionNotFound` above makes at `start`, moved onto
 * the read that no longer starts anything: `getSessionMessages` "returns Array of messages, or
 * empty array if session not found" (`sdk.d.ts`), so the empty read is two answers in one and the
 * store's own listing is what tells them apart.
 */
export const transcriptSessionNotFound = (sessionId: string): TranscriptError =>
	new TranscriptError({
		reason: "session-not-found",
		sessionId,
		detail: "the Claude session store holds no session with this id",
	});

export const transcriptUnreadable = (sessionId: string, cause: unknown): TranscriptError =>
	retaining(
		cause,
		new TranscriptError({
			reason: "store-unreadable",
			sessionId,
			detail: translated("the Claude Code session store did not answer", cause),
		}),
	);

export const transcriptUnknownCursor = (sessionId: string, reason: string): TranscriptError =>
	new TranscriptError({reason: "unknown-cursor", sessionId, detail: reason});

/**
 * The session store could not be enumerated. Never `unsupported`: this backend does list, so a
 * throw here is a store that would not open, not a backend that cannot look.
 */
export const storeUnlistable = (cause: unknown): ListError =>
	retaining(
		cause,
		new ListError({
			reason: "store-unreadable",
			detail: translated("the Claude Code session store could not be enumerated", cause),
		}),
	);

/** The subprocess went away. `no automatic respawn` is the whole retry policy (#7371). */
export const subprocessGone = (detail: string): TransportError =>
	new TransportError({reason: "disconnected", detail});

/** The async iterator itself threw, which is the transport failing rather than the session ending. */
export const streamFailed = (cause: unknown): TransportError =>
	retaining(
		cause,
		new TransportError({
			reason: "protocol",
			detail: translated("the Claude Code message stream stopped", cause),
		}),
	);

/**
 * A control request the CLI would not take. It never reaches the caller — `interrupt` and `setMode`
 * declare no channel for it — so it exists to keep the refusal's cause typed rather than `unknown`.
 */
export const controlRefused = (cause: unknown): TransportError =>
	retaining(
		cause,
		new TransportError({
			reason: "refused",
			detail: translated("the Claude Code CLI did not answer the control request", cause),
		}),
	);

/**
 * A refused `Query.interrupt()`, as the plain failure the event stream carries (ADR 0356).
 *
 * The SDK's `interrupt()` resolves to a receipt or rejects, and the rejection carries no account of
 * *why* the CLI would not stop (`sdk.d.ts`, `Query.interrupt`) — so `turnRunning` is the layer's own
 * reading off `TurnState.settled`, and it is the half the fold routes on. A log line in its place
 * left the window unable to tell a backend that said no from an abort still in flight.
 */
export const interruptFailureOf = (refusal: TransportError, turnRunning: boolean): AgentFailure => {
	const error = new InterruptError({
		reason: turnRunning ? "turn-running" : "no-live-turn",
		detail: refusal.detail,
	});
	return {tag: error._tag, reason: error.reason, detail: error.message};
};
