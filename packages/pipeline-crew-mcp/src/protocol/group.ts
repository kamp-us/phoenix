/**
 * protocol/group — the crew message kinds as one Effect `RpcGroup`.
 *
 * Generic (crew-agnostic); see the boundary note in `../index.ts`. Each kind is an
 * `Rpc` carrying a Schema payload from `./schema.ts`. Kinds that expect an answer
 * (claim/collision-check, role lookup) set a `success` schema — a typed reply the
 * caller awaits; the fire-and-forget kinds leave `success` unset, so it defaults to
 * `Schema.Void` (effect-smol `Rpc.ts` — `const successSchema = options?.success ?? Schema.Void`).
 * That success/void split is exactly what distinguishes a request-response kind from a
 * fire-and-forget one on the wire.
 */
import {Option, Schema} from "effect";
import {Rpc, RpcGroup} from "effect/unstable/rpc";
import * as Messages from "./schema.ts";

/** Kind 1 — synchronous claim/collision-check: a request that awaits a typed `ClaimReply`. */
export const Claim = Rpc.make("Claim", {
	payload: Messages.ClaimRequest,
	success: Messages.ClaimReply,
});

/** Kind 1b — release a held resource claim (fire-and-forget; the claim lifecycle's free, ADR 0191). */
export const Release = Rpc.make("Release", {
	payload: Messages.ReleaseClaim,
});

/** Kind 2 — drain-progress tally. */
export const DrainProgress = Rpc.make("DrainProgress", {
	payload: Messages.DrainProgressTally,
});

/** Kind 3 — intake ping. */
export const IntakePing = Rpc.make("IntakePing", {
	payload: Messages.IntakePing,
});

/**
 * Kind 6 — engine nudge: advisory, non-routing, fire-and-forget. Rides the same fire-and-forget
 * shape as `IntakePing` (no reply, dropped ⇒ log-and-continue); scoped chief-of-staff → engine at
 * the crew catalog. Advisory only — never command authority or lane-assignment (ADR 0189).
 */
export const EngineNudge = Rpc.make("EngineNudge", {
	payload: Messages.EngineNudge,
});

/**
 * Kind 8 — nudge ack: the typed answer to an `EngineNudge`, fire-and-forget like the nudge it
 * answers. A reply is its own kind rather than a nudge sent backwards — that conflation, with the
 * answer as prose in a field meant for something else, is the defect (#3956). Same advisory class:
 * never command authority, a dropped ack is log-and-continue (ADR 0204).
 */
export const NudgeAck = Rpc.make("NudgeAck", {
	payload: Messages.NudgeAck,
});

/** Kind 4a — role discovery/presence: announce (fire-and-forget). */
export const AnnouncePresence = Rpc.make("AnnouncePresence", {
	payload: Messages.PresenceAnnouncement,
});

/** Kind 4b — role discovery/presence: lookup, awaiting a typed `RoleLookupResult`. */
export const LookupRole = Rpc.make("LookupRole", {
	payload: Messages.RoleLookupQuery,
	success: Messages.RoleLookupResult,
});

/** Kind 5 — heartbeat (presence TTL keepalive). */
export const Heartbeat = Rpc.make("Heartbeat", {
	payload: Messages.Heartbeat,
});

/**
 * Kind 7 — claim-holder lookup, awaiting a typed `LookupClaimResult`. The read side of the
 * resource-claim keyspace (ADR 0191), symmetric to `LookupRole` over the presence keyspace: it
 * resolves the live holder of a resource so the claim-aware send path can route a nudge about a
 * claimed target to its owning seat (#3886). Control-plane only — like `LookupRole`, it is served
 * by the tracker registry, never relayed peer-to-peer.
 */
export const LookupClaim = Rpc.make("LookupClaim", {
	payload: Messages.LookupClaimQuery,
	success: Messages.LookupClaimResult,
});

/** The full crew message catalog — one transport-agnostic `RpcGroup` over every kind. */
export const CrewProtocol = RpcGroup.make(
	Claim,
	Release,
	DrainProgress,
	IntakePing,
	EngineNudge,
	NudgeAck,
	AnnouncePresence,
	LookupRole,
	Heartbeat,
	LookupClaim,
);

/** The catalog's wire `kind` names — the `_tag` of every rpc, the set a `channel_send` may name. */
export const crewMessageKinds: ReadonlyArray<string> = [...CrewProtocol.requests.keys()];

/**
 * Resolve a wire `kind` name to the Schema payload the catalog types it as — the seam that lets
 * a boundary decode a message's `body` against its kind instead of trusting `Schema.Unknown`,
 * so the catalog is enforced at the wire rather than advisory (#3229). Derived straight
 * from `CrewProtocol.requests` so it can never drift from the catalog above — the catalog *is*
 * the map. A kind outside the catalog resolves to `undefined`; the caller rejects it.
 *
 * The return is a plain-decoding `Schema.Codec` (no decoding services): `Rpc.payloadSchema`
 * erases to `Schema.Top` (services `unknown`), but every catalog payload is a plain `Struct`
 * with no service dependency, so the narrower type is the true one — and it lets a caller
 * `decodeUnknownEffect` the resolved schema with a `never` requirement channel.
 */
export const payloadSchemaForKind = (kind: string): Schema.Codec<unknown> | undefined =>
	CrewProtocol.requests.get(kind)?.payloadSchema as Schema.Codec<unknown> | undefined;

/**
 * The claim-resource key a message routes by, or `undefined` when it names none — what the
 * claim-aware send path consults to decide single-seat vs broadcast delivery (#3886). Only
 * `EngineNudge` carries a claimable target today, mapped to the canonical `pr-N`/`issue-N` key
 * (`Messages.nudgeTargetResourceKey`, the single-source convention). `NudgeAck` names the same
 * target but is deliberately NOT claim-routed: the answering peer is typically the claim holder,
 * so routing an ack by its target would deliver it back to its own sender instead of to the peer
 * that nudged. Any other kind, or a body
 * that does not decode as an `EngineNudge`, yields `undefined` ⇒ the send broadcasts, so a
 * malformed or non-nudge message degrades to the pre-claim-aware fan-out rather than throwing.
 * This is the one place the catalog declares "this kind routes by claim, on this key."
 */
export const claimResourceKey = (kind: string, body: unknown): string | undefined => {
	if (kind !== EngineNudge._tag) return undefined;
	return Option.getOrUndefined(
		Option.map(Schema.decodeUnknownOption(Messages.EngineNudge)(body), (nudge) =>
			Messages.nudgeTargetResourceKey(nudge.target),
		),
	);
};
