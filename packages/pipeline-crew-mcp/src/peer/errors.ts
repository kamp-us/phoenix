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
