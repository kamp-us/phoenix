/**
 * One tagged error per `TuvalAiAgent` method, plus the one the event stream can fail with.
 *
 * The shape is the founder's API-walk ruling 3 (#7570): six classes keyed by the method that
 * raises them, each enumerating its own cases in a `reason` field, rather than one class per
 * failure case. That departs from `.patterns/effect-errors.md`'s "one class, one code" rule
 * deliberately — the core maps each error to a `failed` Msg carrying the tag as data, so the tag
 * has to be the method, and `SessionNotFound`, `SessionLocked`, `Disconnected` and `Refused` are
 * cases inside these rather than tags of their own.
 *
 * No `FateWireCode` annotation anywhere: Tuval is a local app and none of this reaches a wire
 * (#7465).
 */

import {Schema} from "effect";

/** Why `start` could not open a session. `session-not-found` is the resume-by-id miss. */
export const StartReason = Schema.Literals([
	"session-not-found",
	"session-locked",
	"refused",
	"transport",
]);
export type StartReason = typeof StartReason.Type;

export class StartError extends Schema.TaggedError<StartError>()("tuval/ai-agent/StartError", {
	reason: StartReason,
	cwd: Schema.String,
	detail: Schema.String,
}) {
	override get message(): string {
		return `the agent could not start in "${this.cwd}" (${this.reason}): ${this.detail}`;
	}
}

/** Why a prompt did not reach the backend. A dropped duplicate key is not one — that is a success. */
export const PromptReason = Schema.Literals(["no-session", "refused", "disconnected"]);
export type PromptReason = typeof PromptReason.Type;

export class PromptError extends Schema.TaggedError<PromptError>()("tuval/ai-agent/PromptError", {
	reason: PromptReason,
	detail: Schema.String,
}) {
	override get message(): string {
		return `the prompt was not sent (${this.reason}): ${this.detail}`;
	}
}

/** `answer` named a permission request this session never raised, or already resolved. */
export class UnknownRequest extends Schema.TaggedError<UnknownRequest>()(
	"tuval/ai-agent/UnknownRequest",
	{request: Schema.String},
) {
	override get message(): string {
		return `no permission request "${this.request}" is pending`;
	}
}

/** `setMode` named a mode this agent does not offer. `available` is what it does offer. */
export class ModeUnsupported extends Schema.TaggedError<ModeUnsupported>()(
	"tuval/ai-agent/ModeUnsupported",
	{mode: Schema.String, available: Schema.Array(Schema.String)},
) {
	override get message(): string {
		return `mode "${this.mode}" is not offered; available: ${this.available.join(", ") || "none"}`;
	}
}

/**
 * `setModel` named a model this agent does not offer. `available` is the offered set — the
 * auth-filtered list the layer advertised, never a backend's raw catalog (#7981) — as the ids a
 * window would render, so nothing backend-shaped rides the error either.
 */
export class ModelUnsupported extends Schema.TaggedError<ModelUnsupported>()(
	"tuval/ai-agent/ModelUnsupported",
	{model: Schema.String, available: Schema.Array(Schema.String)},
) {
	override get message(): string {
		return `model "${this.model}" is not offered; available: ${this.available.join(", ") || "none"}`;
	}
}

/**
 * `setThinkingLevel` named a level this agent does not offer for the model it is running on.
 * `available` is that offered set — Claude's effort axis has neither `off` nor `minimal`, and Pi
 * advertises `off` alone for a model that does not reason (#8062).
 */
export class ThinkingUnsupported extends Schema.TaggedError<ThinkingUnsupported>()(
	"tuval/ai-agent/ThinkingUnsupported",
	{level: Schema.String, available: Schema.Array(Schema.String)},
) {
	override get message(): string {
		return `thinking level "${this.level}" is not offered; available: ${this.available.join(", ") || "none"}`;
	}
}

/**
 * Why a page of history did not come back. History is the backend's store, so it can be missing.
 *
 * The two subagent cases are separate from `store-unreadable` because a subagent's transcript is a
 * file of its own: a subagent nobody stored and a store that would not open are different answers,
 * and so is a file that opened and then held a line nothing can parse. Collapsing any of them into
 * an empty transcript would say the subagent spoke and said nothing (#8404).
 */
export const PageReason = Schema.Literals([
	"unknown-cursor",
	"store-unreadable",
	"disconnected",
	"subagent-not-found",
	"subagent-malformed",
]);
export type PageReason = typeof PageReason.Type;

export class PageError extends Schema.TaggedError<PageError>()("tuval/ai-agent/PageError", {
	reason: PageReason,
	detail: Schema.String,
}) {
	override get message(): string {
		return `a page of history could not be read (${this.reason}): ${this.detail}`;
	}
}

/**
 * Why a stored transcript did not come back. `sessionTranscript` reads the store off disk with no
 * session open, so its cases are the store's and never the connection's — the same split
 * `ListError` draws for `listSessions`.
 *
 * `session-not-found` is the whole reason this is not `PageError`: a store that does not hold the
 * named session is a different answer from an empty page, and a read that could not tell them
 * apart would render a lost session as a session that said nothing (epic #8070, ruling 2).
 */
export const TranscriptReason = Schema.Literals([
	"session-not-found",
	"store-unreadable",
	"unknown-cursor",
]);
export type TranscriptReason = typeof TranscriptReason.Type;

export class TranscriptError extends Schema.TaggedError<TranscriptError>()(
	"tuval/ai-agent/TranscriptError",
	{reason: TranscriptReason, sessionId: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `the stored transcript for "${this.sessionId}" could not be read (${this.reason}): ${this.detail}`;
	}
}

/**
 * Why a session listing did not come back. Listing reads the backend's store off disk without the
 * session transport in it at all, so its cases are the store's, not the connection's.
 *
 * `unsupported` is a real answer rather than an empty list: a backend that cannot enumerate has not
 * told the operator he has no sessions, and the session list must be able to say which of the two
 * it heard.
 */
export const ListReason = Schema.Literals(["store-unreadable", "unsupported"]);
export type ListReason = typeof ListReason.Type;

export class ListError extends Schema.TaggedError<ListError>()("tuval/ai-agent/ListError", {
	reason: ListReason,
	detail: Schema.String,
}) {
	override get message(): string {
		return `the session list could not be read (${this.reason}): ${this.detail}`;
	}
}

/** The event stream's only failure. `disconnected` is the old `Disconnected` name, as a case. */
export const TransportReason = Schema.Literals(["disconnected", "refused", "protocol"]);
export type TransportReason = typeof TransportReason.Type;

export class TransportError extends Schema.TaggedError<TransportError>()(
	"tuval/ai-agent/TransportError",
	{reason: TransportReason, detail: Schema.String},
) {
	override get message(): string {
		return `the agent transport failed (${this.reason}): ${this.detail}`;
	}
}
