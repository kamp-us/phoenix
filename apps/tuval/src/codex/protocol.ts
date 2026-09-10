import {Effect, Schema} from "effect";
import {protocolError} from "./transport.ts";

// Projections of codex-cli 0.153.4's generated app-server schema. See .patterns/tuval-codex.md.
export const WireItem = Schema.Struct({type: Schema.String, id: Schema.String});
export const Turn = Schema.Struct({
	id: Schema.String,
	status: Schema.String,
	items: Schema.Array(Schema.Unknown),
	error: Schema.optionalKey(Schema.NullOr(Schema.Struct({message: Schema.String}))),
	startedAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
export const Thread = Schema.Struct({
	id: Schema.String,
	cwd: Schema.String,
	preview: Schema.String,
	updatedAt: Schema.Finite,
	createdAt: Schema.Finite,
	historyMode: Schema.optionalKey(Schema.String),
	turns: Schema.Array(Turn),
	gitInfo: Schema.optionalKey(Schema.NullOr(Schema.Struct({branch: Schema.NullOr(Schema.String)}))),
	canAcceptDirectInput: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type Thread = typeof Thread.Type;
export const Opened = Schema.Struct({
	thread: Thread,
	model: Schema.String,
	modelProvider: Schema.String,
	approvalPolicy: Schema.Unknown,
	sandbox: Schema.Struct({type: Schema.String}),
	reasoningEffort: Schema.NullOr(Schema.String),
});
export const Model = Schema.Struct({
	model: Schema.String,
	displayName: Schema.String,
	hidden: Schema.Boolean,
	supportedReasoningEfforts: Schema.Array(Schema.Struct({reasoningEffort: Schema.String})),
	defaultReasoningEffort: Schema.String,
});
export type Model = typeof Model.Type;
export const Models = Schema.Struct({
	data: Schema.Array(Model),
	nextCursor: Schema.NullOr(Schema.String),
});
export const Threads = Schema.Struct({
	data: Schema.Array(Thread),
	nextCursor: Schema.NullOr(Schema.String),
});
export const ReadThread = Schema.Struct({thread: Thread});
export const TurnReply = Schema.Struct({turn: Turn});
export const ThreadEvent = Schema.Struct({threadId: Schema.String});
export const ItemEvent = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	item: Schema.Unknown,
});
export const Delta = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	itemId: Schema.String,
	delta: Schema.String,
});
export const TurnEvent = Schema.Struct({threadId: Schema.String, turn: Turn});
export const Approval = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	itemId: Schema.String,
	reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
	command: Schema.optionalKey(Schema.NullOr(Schema.String)),
	availableDecisions: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
export const Resolved = Schema.Struct({
	threadId: Schema.String,
	requestId: Schema.Union([Schema.String, Schema.Finite]),
});
export const Usage = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	tokenUsage: Schema.Struct({
		total: Schema.Struct({inputTokens: Schema.Finite, outputTokens: Schema.Finite}),
		last: Schema.Struct({inputTokens: Schema.Finite, outputTokens: Schema.Finite}),
	}),
});

export const decode = <A>(schema: Schema.Codec<A>, value: unknown) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(protocolError));
