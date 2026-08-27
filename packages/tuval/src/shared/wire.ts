import * as Schema from "effect/Schema";

export const PiSessionIdentity = Schema.Struct({
	id: Schema.String,
	nativeId: Schema.String,
	sourceId: Schema.String,
});

export const DiscoveredSession = Schema.Struct({
	identity: PiSessionIdentity,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	cwd: Schema.String,
	name: Schema.optionalKey(Schema.String),
});

export const DiscoverySource = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	sessionCount: Schema.Number,
	skippedEntries: Schema.Number,
});

const DiscoveryBase = {
	sessions: Schema.Array(DiscoveredSession),
	sources: Schema.Array(DiscoverySource),
};

export const DiscoveryReady = Schema.Struct({
	kind: Schema.Literal("ready"),
	...DiscoveryBase,
});

export const DiscoveryEmpty = Schema.Struct({
	kind: Schema.Literal("empty"),
	...DiscoveryBase,
});

export const DiscoveryPartial = Schema.Struct({
	kind: Schema.Literal("partial"),
	...DiscoveryBase,
	issues: Schema.Array(Schema.String),
});

export const DiscoveryTransportFailure = Schema.Struct({
	kind: Schema.Literal("transport"),
	message: Schema.String,
	sessions: Schema.Array(DiscoveredSession),
	sources: Schema.Array(DiscoverySource),
});

export const DiscoveryFatalFailure = Schema.Struct({
	kind: Schema.Literal("fatal"),
	message: Schema.String,
	sessions: Schema.Array(DiscoveredSession),
	sources: Schema.Array(DiscoverySource),
});

export const DiscoveryOutcome = Schema.Union([
	DiscoveryReady,
	DiscoveryEmpty,
	DiscoveryPartial,
	DiscoveryTransportFailure,
	DiscoveryFatalFailure,
]);

export type PiSessionIdentity = typeof PiSessionIdentity.Type;
export type DiscoveredSession = typeof DiscoveredSession.Type;
export type DiscoverySource = typeof DiscoverySource.Type;
export type DiscoveryOutcome = typeof DiscoveryOutcome.Type;
