import * as Schema from "effect/Schema";

export const ModelRef = Schema.Struct({
	provider: Schema.String,
	id: Schema.String,
});
export type ModelRef = (typeof ModelRef)["Type"];

export const ThinkingLevel = Schema.Literals([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export type ThinkingLevel = (typeof ThinkingLevel)["Type"];

export const SessionPhase = Schema.Literals([
	"idle",
	"turn",
	"compaction",
	"branch_summary",
	"retry",
]);
export type SessionPhase = (typeof SessionPhase)["Type"];

export const TranscriptContent = Schema.Union([
	Schema.Struct({type: Schema.Literal("text"), text: Schema.String}),
	Schema.Struct({
		type: Schema.Literal("image"),
		data: Schema.String,
		mimeType: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("thinking"),
		thinking: Schema.String,
		redacted: Schema.optionalKey(Schema.Boolean),
	}),
	Schema.Struct({
		type: Schema.Literal("toolCall"),
		toolCallId: Schema.String,
		toolName: Schema.String,
		input: Schema.Unknown,
	}),
]);
export type TranscriptContent = (typeof TranscriptContent)["Type"];

export const LiveTranscriptEntry = Schema.Struct({
	id: Schema.String,
	role: Schema.Literals(["user", "assistant", "tool"]),
	content: Schema.Array(TranscriptContent),
	timestamp: Schema.Number,
	status: Schema.Literals(["complete", "streaming", "running", "error", "aborted"]),
});
export type LiveTranscriptEntry = (typeof LiveTranscriptEntry)["Type"];

export const LiveSessionCompletion = Schema.Literals([
	"idle",
	"running",
	"complete",
	"error",
	"aborted",
	"disconnected",
]);
export type LiveSessionCompletion = (typeof LiveSessionCompletion)["Type"];

const LiveSessionBase = {
	sessionId: Schema.String,
	revision: Schema.Number,
	phase: SessionPhase,
	model: ModelRef,
	thinkingLevel: ThinkingLevel,
	completion: LiveSessionCompletion,
	transcript: Schema.Array(LiveTranscriptEntry),
	lastEventSequence: Schema.Number,
};

export const AttachedLiveSession = Schema.Struct({
	_tag: Schema.Literal("attached"),
	...LiveSessionBase,
	connection: Schema.Literal("connected"),
	ownership: Schema.Literal("exclusive"),
});
export type AttachedLiveSession = (typeof AttachedLiveSession)["Type"];

export const DisconnectedLiveSession = Schema.Struct({
	_tag: Schema.Literal("disconnected"),
	...LiveSessionBase,
	connection: Schema.Literal("disconnected"),
	ownership: Schema.Literal("none"),
	reason: Schema.String,
});
export type DisconnectedLiveSession = (typeof DisconnectedLiveSession)["Type"];

export const LiveSessionView = Schema.Union([AttachedLiveSession, DisconnectedLiveSession]);
export type LiveSessionView = (typeof LiveSessionView)["Type"];

export const AttachLiveSessionRequest = Schema.Struct({sessionId: Schema.String});
export type AttachLiveSessionRequest = (typeof AttachLiveSessionRequest)["Type"];

export const AttachLiveSessionOutcome = Schema.Union([
	Schema.Struct({_tag: Schema.Literal("attached"), session: AttachedLiveSession}),
	Schema.Struct({
		_tag: Schema.Literal("refused"),
		sessionId: Schema.String,
		code: Schema.Literals(["lease-refused", "disconnected", "not-found", "protocol"]),
		reason: Schema.String,
	}),
]);
export type AttachLiveSessionOutcome = (typeof AttachLiveSessionOutcome)["Type"];

export const PromptLiveSessionRequest = Schema.Struct({
	correlationId: Schema.String,
	text: Schema.String,
});
export type PromptLiveSessionRequest = (typeof PromptLiveSessionRequest)["Type"];

export const PromptLiveSessionOutcome = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("acknowledged"),
		correlationId: Schema.String,
		session: AttachedLiveSession,
	}),
	Schema.Struct({
		_tag: Schema.Literal("refused"),
		correlationId: Schema.String,
		code: Schema.Literals(["no-attachment", "lease-refused", "disconnected", "protocol"]),
		reason: Schema.String,
	}),
]);
export type PromptLiveSessionOutcome = (typeof PromptLiveSessionOutcome)["Type"];

export const ReleaseLiveSessionOutcome = Schema.Struct({
	_tag: Schema.Literal("released"),
	sessionId: Schema.NullOr(Schema.String),
});
export type ReleaseLiveSessionOutcome = (typeof ReleaseLiveSessionOutcome)["Type"];

export const LiveSessionEvent = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("session"),
		sequence: Schema.Number,
		session: LiveSessionView,
	}),
	Schema.Struct({
		_tag: Schema.Literal("prompt"),
		sequence: Schema.Number,
		outcome: PromptLiveSessionOutcome,
	}),
	Schema.Struct({
		_tag: Schema.Literal("released"),
		sequence: Schema.Number,
		sessionId: Schema.String,
	}),
	Schema.Struct({
		_tag: Schema.Literal("diagnostic"),
		sequence: Schema.Number,
		sessionId: Schema.NullOr(Schema.String),
		message: Schema.String,
	}),
]);
export type LiveSessionEvent = (typeof LiveSessionEvent)["Type"];

export const LiveSessionEventsRequest = Schema.Struct({
	afterSequence: Schema.optionalKey(Schema.Number),
});
export type LiveSessionEventsRequest = (typeof LiveSessionEventsRequest)["Type"];
