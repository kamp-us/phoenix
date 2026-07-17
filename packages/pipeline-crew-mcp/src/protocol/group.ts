/**
 * protocol/group — the 6 crew message kinds as one Effect `RpcGroup`.
 *
 * Generic (crew-agnostic); see the boundary note in `../index.ts`. Each kind is an
 * `Rpc` carrying a Schema payload from `./schema.ts`. Kinds that expect an answer
 * (claim/collision-check, role lookup) set a `success` schema — a typed reply the
 * caller awaits; the fire-and-forget kinds leave `success` unset, so it defaults to
 * `Schema.Void` (effect-smol `Rpc.ts` — `const successSchema = options?.success ?? Schema.Void`).
 * That success/void split is exactly what distinguishes a request-response kind from a
 * fire-and-forget one on the wire.
 */
import type {Schema} from "effect";
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

/** The full crew message catalog — one transport-agnostic `RpcGroup` over all 6 kinds. */
export const CrewProtocol = RpcGroup.make(
	Claim,
	Release,
	DrainProgress,
	IntakePing,
	AnnouncePresence,
	LookupRole,
	Heartbeat,
);

/** The catalog's wire `kind` names — the `_tag` of every rpc, the set a `channel_send` may name. */
export const crewMessageKinds: ReadonlyArray<string> = [...CrewProtocol.requests.keys()];

/**
 * Resolve a wire `kind` name to the Schema payload the catalog types it as — the seam that lets
 * a boundary decode a message's `body` against its kind instead of trusting `Schema.Unknown`,
 * so the 6-kind catalog is enforced at the wire rather than advisory (#3229). Derived straight
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
