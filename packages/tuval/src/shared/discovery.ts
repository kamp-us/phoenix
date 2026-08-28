import * as Schema from "effect/Schema";

export const SessionIdentity = Schema.String.pipe(Schema.brand("TuvalSessionIdentity"));
export type SessionIdentity = (typeof SessionIdentity)["Type"];

export const DiscoveredSession = Schema.Struct({
	identity: SessionIdentity,
	piSessionId: Schema.String,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	cwd: Schema.String,
	parentSessionId: Schema.optionalKey(Schema.String),
	sourceFile: Schema.String,
});
export type DiscoveredSession = (typeof DiscoveredSession)["Type"];

export const DiscoveryProblem = Schema.Struct({
	source: Schema.String,
	message: Schema.String,
});
export type DiscoveryProblem = (typeof DiscoveryProblem)["Type"];

export const DiscoveryReady = Schema.Struct({
	_tag: Schema.Literal("ready"),
	sessions: Schema.Array(DiscoveredSession),
});

export const DiscoveryEmpty = Schema.Struct({
	_tag: Schema.Literal("empty"),
	sessions: Schema.Tuple([]),
});

export const DiscoveryPartialSource = Schema.Struct({
	_tag: Schema.Literal("partial-source"),
	sessions: Schema.Array(DiscoveredSession),
	problems: Schema.Array(DiscoveryProblem),
});

export const DiscoveryTransportFailure = Schema.Struct({
	_tag: Schema.Literal("transport"),
	message: Schema.String,
	retryable: Schema.Boolean,
});

export const DiscoveryFatal = Schema.Struct({
	_tag: Schema.Literal("fatal"),
	message: Schema.String,
	problems: Schema.Array(DiscoveryProblem),
});

export const DiscoveryOutcome = Schema.Union([
	DiscoveryReady,
	DiscoveryEmpty,
	DiscoveryPartialSource,
	DiscoveryTransportFailure,
	DiscoveryFatal,
]);
export type DiscoveryOutcome = (typeof DiscoveryOutcome)["Type"];

export const sessionIdentity = (piSessionId: string): SessionIdentity =>
	`pi:${piSessionId}` as SessionIdentity;
