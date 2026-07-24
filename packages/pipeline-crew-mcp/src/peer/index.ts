/**
 * peer/ — the data plane: a session-edge peer that is both an `RpcServer` inbox (receives
 * typed messages, returns inbox-acks) and an `RpcClient` dialer (looks a role up via the
 * tracker and sends peer-to-peer — the tracker never relays). Announces on start and holds
 * its role lease for the connection lifetime (connection-is-lease, #3035); a send to an
 * offline peer fails with a typed `PeerUnreachableError`, never a silent drop.
 *
 * Generic (crew-agnostic): roles and peer-ids are opaque parameters — no baked-in crew
 * noun. The concrete role catalog + wiring is the `crew/` composition root (#3059).
 */

export {type Connect, Dialer, type InboxRpcClient} from "./dialer.ts";
export {ChannelDeafError, PeerUnreachableError} from "./errors.ts";
export {
	Deliver,
	Inbox,
	InboxAck,
	InboxEnvelope,
	inboxHandlers,
	PeerAddress,
	PeerInbox,
} from "./inbox.ts";
export {make, type Peer, type PeerConfig} from "./peer.ts";
export {RolePresence, Tracker} from "./tracker.ts";
