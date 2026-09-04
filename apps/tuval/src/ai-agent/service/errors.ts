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

/** Why a page of history did not come back. History is the backend's store, so it can be missing. */
export const PageReason = Schema.Literals(["unknown-cursor", "store-unreadable", "disconnected"]);
export type PageReason = typeof PageReason.Type;

export class PageError extends Schema.TaggedError<PageError>()("tuval/ai-agent/PageError", {
	reason: PageReason,
	detail: Schema.String,
}) {
	override get message(): string {
		return `a page of history could not be read (${this.reason}): ${this.detail}`;
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
