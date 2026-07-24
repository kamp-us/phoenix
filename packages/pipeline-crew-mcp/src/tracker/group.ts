/**
 * tracker/group — the registry `RpcGroup` the tracker actually serves: a control-plane-only
 * SUBSET of the crew protocol (`../protocol/`).
 *
 * The tracker serves exactly the six registry kinds — `Claim` (the request/reply resource
 * claim), `Release` (freeing a resource claim), `AnnouncePresence` (soft presence), `LookupRole`
 * (presence discovery), `LookupClaim` (resource-claim-holder discovery, ADR 0191's read side),
 * `Heartbeat` (TTL keepalive). It deliberately does NOT serve the message-relay kinds
 * (`DrainProgress`, `IntakePing`, `EngineNudge`): those payloads travel peer-to-peer on the data
 * plane, never through the registry. This exclusion IS the "no message-relay path" invariant — the
 * tracker cannot relay a message it has no handler for. It reuses the protocol's Rpc definitions
 * verbatim; it never redefines a message type.
 */
import {RpcGroup} from "effect/unstable/rpc";
import {
	AnnouncePresence,
	Claim,
	Heartbeat,
	LookupClaim,
	LookupRole,
	Release,
} from "../protocol/index.ts";

/** The control-plane registry surface — presence + role leases + resource claims, no relay kinds. */
export const TrackerRegistry = RpcGroup.make(
	Claim,
	Release,
	AnnouncePresence,
	LookupRole,
	LookupClaim,
	Heartbeat,
);
