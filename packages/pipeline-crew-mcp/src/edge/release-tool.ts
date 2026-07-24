/**
 * edge/release-tool — the release half of the deconfliction edge: an MCP tool a session calls to
 * free a resource claim it holds, the counterpart to `channel_claim` (`./claim-tool.ts`). Generic
 * (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * This is the edge-carry #3796 facet 2 was missing. The release path already existed at every layer
 * BELOW the edge — the `ReleaseClaim` schema + the `Release` RPC (`../protocol/`), the `releaseClaim`
 * seam (`../crew/catalog.ts`), and `CrewTracker.release` (`../crew/tracker.ts`, ADR 0191 facet 3) —
 * but `CrewChannel` carried only `claim` and the session bound only that, so an engine that yielded,
 * stood down, or claimed in error could not hand its claim back: it was held until the session's
 * presence aged out, leaving a phantom claim that spuriously blocked the rightful owner. This tool
 * surfaces the already-correct `Release` so a claim is releasable from the engine toolset.
 *
 * Release is holder-guarded and idempotent (ADR 0191 facet 3): the tracker frees ONLY a claim the
 * caller holds, and freeing a claim you do not hold (or one already gone) is a no-op. So the wire
 * `Release` is fire-and-forget with no reply — the tool has no failure channel, and its `released`
 * ack means "the release was accepted", not "you were the holder" (the holder-guard is the tracker's,
 * and a caller cannot learn another peer's holdership from its own release).
 */
import {Context, Effect, Schema} from "effect";
import {Tool, Toolkit} from "effect/unstable/ai";

/**
 * The resource-release capability the tool wraps — the session's `CrewChannel.release` bound in the
 * composition root (`../crew/channel-server.ts`), so the edge never constructs a tracker client (the
 * crew composition does, #3059). `release(resource)` hits the tracker's `Release` RPC; releasing is
 * holder-guarded + idempotent, so the capability has no error channel (a lost/absent claim no-ops).
 */
export class ChannelRelease extends Context.Service<
	ChannelRelease,
	{
		readonly release: (resource: string) => Effect.Effect<void>;
	}
>()("@kampus/pipeline-crew-mcp/edge/ChannelRelease") {}

/**
 * The release acknowledgement — an edge-local ack, NOT a wire reply: the `Release` RPC is
 * fire-and-forget (ADR 0191 facet 3), so `released` reports that the release was accepted (idempotent;
 * it frees your claim iff you hold it), never that you were the holder.
 */
export const ReleaseAck = Schema.Struct({
	resource: Schema.NonEmptyString,
	released: Schema.Boolean,
});

/** The one release tool: `{resource}` in, the accepted-release ack out. */
export const ReleaseResource = Tool.make("channel_release", {
	description:
		"Release a resource claim you hold (an issue or PR id), the counterpart to channel_claim; call " +
		"it when you yield a lane, are told to stand down, or claimed in error, so the claim frees now " +
		"instead of waiting for your session presence to age out. Holder-guarded and idempotent: it " +
		"frees the claim ONLY if you hold it, and releasing one you do not hold (or already released) " +
		"is a safe no-op.",
	parameters: Schema.Struct({resource: Schema.NonEmptyString}),
	success: ReleaseAck,
});

/** The release toolkit — registered on the session's one served `McpServer` alongside `channel_claim`. */
export const ReleaseToolkit = Toolkit.make(ReleaseResource);

/** The toolkit handler: route the release through the `ChannelRelease` port (the session's tracker release). */
export const releaseToolHandlers = ReleaseToolkit.toLayer(
	Effect.gen(function* () {
		const releaser = yield* ChannelRelease;
		return {
			channel_release: ({resource}) =>
				releaser.release(resource).pipe(Effect.as({resource, released: true})),
		};
	}),
);
