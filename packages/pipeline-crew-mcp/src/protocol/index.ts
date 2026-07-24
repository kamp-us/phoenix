/**
 * protocol/ — the typed message catalog: the crew's 7 message kinds as an Effect
 * `RpcGroup` with `effect/Schema` payloads, transport-agnostic. Generic (crew-agnostic);
 * see the boundary note in `../index.ts`. This module defines the wire contract that
 * tracker, peer, and edge all code against.
 */
export {
	ChannelContractError,
	describeKind,
	type KindContract,
	resolveKindContracts,
	resolveKindContractsFor,
} from "./describe.ts";
export {
	AnnouncePresence,
	Claim,
	CrewProtocol,
	claimResourceKey,
	crewMessageKinds,
	DrainProgress,
	EngineNudge,
	Heartbeat,
	IntakePing,
	LookupClaim,
	LookupRole,
	payloadSchemaForKind,
	Release,
} from "./group.ts";
export * as Messages from "./schema.ts";
