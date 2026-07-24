/**
 * peer/errors — the typed failures a session-edge peer raises. Generic (crew-agnostic);
 * see the boundary note in `../index.ts`.
 */
import {Schema} from "effect";

/**
 * A dial to a target that is absent, expired, or unreachable. This is the honest
 * offline-receiver behavior locked in #3035 (epic #3045): no store-and-forward, no queue
 * — a failed dial surfaces loudly as this typed error, never a silent drop.
 */
export class PeerUnreachableError extends Schema.TaggedErrorClass<PeerUnreachableError>()(
	"@kampus/pipeline-crew-mcp/PeerUnreachableError",
	{
		target: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * A send whose target role IS present in the tracker but whose inbox is not actually serving —
 * "channel-deaf". This is the failure the presence-reflects-a-live-channel-half fix makes legible
 * (#3628): a peer used to be able to announce presence without its inbox socket ever attaching, so a
 * dial found a live lease but a dead socket. Distinct from `PeerUnreachableError` (no live peer
 * registered at all) so a caller can tell "nobody is there" apart from "someone is registered but
 * their channel half never attached", and it fails FAST (a bounded dial) rather than hanging on a
 * dead or orphaned socket.
 */
export class ChannelDeafError extends Schema.TaggedErrorClass<ChannelDeafError>()(
	"@kampus/pipeline-crew-mcp/ChannelDeafError",
	{
		target: Schema.String,
		address: Schema.String,
		reason: Schema.String,
	},
) {
	// McpServer renders a failed tool call as `Cause.pretty(cause)` (effect-smol McpServer.ts), which
	// prints an error's `message`; a bare TaggedError's is empty. Fold the why into `message` so the
	// channel-deaf reason reaches the tool output without reading source (the #3486 precedent).
	override get message(): string {
		return `channel-deaf: role "${this.target}" is registered at ${this.address} but its inbox is not serving — ${this.reason}`;
	}
}
