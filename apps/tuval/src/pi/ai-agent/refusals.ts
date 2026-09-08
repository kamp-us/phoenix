/** Pi refusals become operation-specific generic errors; causes stay local (see backend-exception-translation.md). */
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
import type {ConnectionRefusal, Disconnected, SessionRefusal} from "../client/index.ts";
import {retaining} from "../diagnostics.ts";

type Refusal = SessionRefusal | ConnectionRefusal;
const detail = (operation: string, refusal: Refusal): string => {
	switch (refusal._tag) {
		case "tuval/pi/client/SessionNotFound":
			return `${operation}: the session is no longer available`;
		case "tuval/pi/client/SessionLocked":
			return `${operation}: another connection holds the session`;
		case "tuval/pi/client/Disconnected":
			return `${operation}: the Pi connection closed; reopen the session to reconnect`;
		case "tuval/pi/client/ProtocolRefused":
			return `${operation}: the Pi server refused the request`;
	}
};
export const startErrorOf = (cwd: string, refusal: Refusal): StartError =>
	retaining(
		refusal,
		new StartError({
			cwd,
			detail: detail("Pi could not start or resume the session", refusal),
			reason:
				refusal._tag === "tuval/pi/client/SessionNotFound"
					? "session-not-found"
					: refusal._tag === "tuval/pi/client/SessionLocked"
						? "session-locked"
						: refusal._tag === "tuval/pi/client/Disconnected"
							? "transport"
							: "refused",
		}),
	);
export const promptErrorOf = (refusal: SessionRefusal): PromptError =>
	retaining(
		refusal,
		new PromptError({
			detail: detail("Pi could not send the message", refusal),
			reason:
				refusal._tag === "tuval/pi/client/SessionNotFound"
					? "no-session"
					: refusal._tag === "tuval/pi/client/Disconnected"
						? "disconnected"
						: "refused",
		}),
	);
export const transportErrorOf = (refusal: Disconnected): TransportError =>
	retaining(
		refusal,
		new TransportError({
			reason: "disconnected",
			detail: "Pi stopped receiving session updates; reopen the session to reconnect",
		}),
	);
export const promptFailureOf = (refusal: PromptError): AgentFailure => ({
	tag: refusal._tag,
	reason: refusal.reason,
	detail: refusal.message,
});
export const storeUnreadable = (cause: unknown): PageError =>
	retaining(
		cause,
		new PageError({
			reason: "store-unreadable",
			detail: "Pi could not read this session's history page",
		}),
	);
export const storeUnlistable = (cause: unknown): ListError =>
	retaining(
		cause,
		new ListError({
			reason: "store-unreadable",
			detail: "Pi could not enumerate the session stores",
		}),
	);
export const transcriptSessionMissing = (sessionId: string): TranscriptError =>
	new TranscriptError({
		reason: "session-not-found",
		sessionId,
		detail: "neither of Pi's session stores holds a file for this id",
	});
export const transcriptUnreadable = (sessionId: string, cause: unknown): TranscriptError =>
	retaining(
		cause,
		new TranscriptError({
			reason: "store-unreadable",
			sessionId,
			detail: "Pi could not read the stored session transcript",
		}),
	);
export const transcriptUnknownCursor = (sessionId: string, reason: string): TranscriptError =>
	new TranscriptError({reason: "unknown-cursor", sessionId, detail: reason});
export const promptDropOf = (refusal: PromptError): TransportError =>
	retaining(
		refusal,
		new TransportError({
			reason: "disconnected",
			detail:
				"Pi could not send the message because the connection closed; reopen the session to reconnect",
		}),
	);
/** Refused interrupts remain nonterminal events; turnRunning remains the fold's transition discriminant. */
export const interruptFailureOf = (refusal: SessionRefusal, turnRunning: boolean): AgentFailure => {
	const error = retaining(
		refusal,
		new InterruptError({
			reason: turnRunning ? "turn-running" : "no-live-turn",
			detail: detail("Pi could not interrupt the turn", refusal),
		}),
	);
	return {tag: error._tag, reason: error.reason, detail: error.message};
};
