/**
 * tracker/group — the registry `RpcGroup` the tracker actually serves: a control-plane-only
 * SUBSET of the crew protocol (`../protocol/`).
 *
 * The tracker serves exactly the five registry kinds — `Claim` (the request/reply resource
 * claim), `Release` (freeing a resource claim), `AnnouncePresence` (soft presence), `LookupRole`
 * (discovery), `Heartbeat` (TTL keepalive). It deliberately does NOT serve the four message-relay
 * kinds (`EpicHandoff`, `DrainProgress`, `IntakePing`, `AckInbox`): those payloads travel
 * peer-to-peer on the data plane, never through the registry. This exclusion IS the "no
 * message-relay path" invariant — the tracker cannot relay a message it has no handler for. It
 * reuses the protocol's Rpc definitions verbatim; it never redefines a message type.
 */
import {RpcGroup} from "effect/unstable/rpc";
import {AnnouncePresence, Claim, Heartbeat, LookupRole, Release} from "../protocol/index.ts";

/** The control-plane registry surface — presence + role leases + resource claims, no relay kinds. */
export const TrackerRegistry = RpcGroup.make(
	Claim,
	Release,
	AnnouncePresence,
	LookupRole,
	Heartbeat,
);
