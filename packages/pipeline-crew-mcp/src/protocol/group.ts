/**
 * protocol/group — the 7 crew message kinds as one Effect `RpcGroup`.
 *
 * Generic (crew-agnostic); see the boundary note in `../index.ts`. Each kind is an
 * `Rpc` carrying a Schema payload from `./schema.ts`. Kinds that expect an answer
 * (claim/collision-check, role lookup) set a `success` schema — a typed reply the
 * caller awaits; the fire-and-forget kinds leave `success` unset, so it defaults to
 * `Schema.Void`. That success/void split is exactly what distinguishes a
 * request-response kind from a fire-and-forget one on the wire.
 */
import {Rpc, RpcGroup} from "effect/unstable/rpc";
import * as Messages from "./schema.ts";

/** Kind 1 — synchronous claim/collision-check: a request that awaits a typed `ClaimReply`. */
export const Claim = Rpc.make("Claim", {
	payload: Messages.ClaimRequest,
	success: Messages.ClaimReply,
});

/** Kind 2 — planned-epic handoff (EM → builder). */
export const EpicHandoff = Rpc.make("EpicHandoff", {
	payload: Messages.EpicHandoffNotice,
});

/** Kind 3 — drain-progress tally. */
export const DrainProgress = Rpc.make("DrainProgress", {
	payload: Messages.DrainProgressTally,
});

/** Kind 4 — intake ping. */
export const IntakePing = Rpc.make("IntakePing", {
	payload: Messages.IntakePing,
});

/** Kind 5a — role discovery/presence: announce (fire-and-forget). */
export const AnnouncePresence = Rpc.make("AnnouncePresence", {
	payload: Messages.PresenceAnnouncement,
});

/** Kind 5b — role discovery/presence: lookup, awaiting a typed `RoleLookupResult`. */
export const LookupRole = Rpc.make("LookupRole", {
	payload: Messages.RoleLookupQuery,
	success: Messages.RoleLookupResult,
});

/** Kind 6 — heartbeat (presence TTL keepalive). */
export const Heartbeat = Rpc.make("Heartbeat", {
	payload: Messages.Heartbeat,
});

/** Kind 7 — inbox ack (delivery acknowledgement). */
export const AckInbox = Rpc.make("AckInbox", {
	payload: Messages.InboxAck,
});

/** The full crew message catalog — one transport-agnostic `RpcGroup` over all 7 kinds. */
export const CrewProtocol = RpcGroup.make(
	Claim,
	EpicHandoff,
	DrainProgress,
	IntakePing,
	AnnouncePresence,
	LookupRole,
	Heartbeat,
	AckInbox,
);
