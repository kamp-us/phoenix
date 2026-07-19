/**
 * edge/claim-tool — the deconfliction half of the channel edge: an MCP tool a session calls to
 * claim a resource (an issue) against the tracker BEFORE it opens a lane, so N engines sharing
 * one board get resource-keyed mutual exclusion. Generic (crew-agnostic); see the boundary note
 * in `../index.ts`.
 *
 * This is the seam #3509 was missing. The tracker already answers a resource claim with a typed
 * granted/collision reply (`../crew/tracker.ts` `CrewTracker.claim` → `../tracker/registry-core.ts`
 * `claimResource`, ADR 0191) and that primitive is correct — a second live holder of a resource
 * gets a `Collision`, not a second grant. But the edge exposed ONLY `channel_send` (a peer→inbox
 * relay), so an engine could not reach the claim at all: it fell back to the GitHub §7 marker,
 * which ADR 0115 documents as degenerate under the shared `usirin` login, and two engines both
 * "claimed" one issue and both opened a lane (#3498 → PRs #3503 + #3508). This tool surfaces the
 * already-correct resource claim so the "claim before you open a lane" instruction is fulfillable.
 *
 * A collision is a VALUE in the reply, never a tool error — the claim never fails (its transport
 * error is `orDie`'d at the `CrewTracker` seam), so the tool carries no failure channel. The caller
 * reads `granted`/`collision`: granted ⇒ you own the lane, collision ⇒ another engine holds it and
 * `owner` names it — back off before opening a PR.
 */
import {Context, Effect, Schema} from "effect";
import {Tool, Toolkit} from "effect/unstable/ai";
import {Messages} from "../protocol/index.ts";

/** The typed answer to a claim/collision-check — the protocol `ClaimReply`, re-named for callers. */
export type ClaimReply = typeof Messages.ClaimReply.Type;

/**
 * The resource-claim capability the tool wraps — the session's `CrewChannel.claim` bound in the
 * composition root (`../crew/channel-server.ts`), so the edge never constructs a tracker client
 * (the crew composition does, #3059). `claim(resource)` hits the tracker's `Claim` RPC and returns
 * the typed granted/collision reply; a collision is a value, so the capability has no error channel.
 */
export class ChannelClaim extends Context.Service<
	ChannelClaim,
	{
		readonly claim: (resource: string) => Effect.Effect<ClaimReply>;
	}
>()("@kampus/pipeline-crew-mcp/edge/ChannelClaim") {}

/** The one claim tool: `{resource}` in, the tracker's typed granted/collision reply out. */
export const ClaimResource = Tool.make("channel_claim", {
	description:
		"Claim a resource (an issue id) against the tracker before opening a build lane; returns the " +
		"typed reply. `granted: true` ⇒ you now hold the lane; `collision: true` ⇒ another engine " +
		"already holds it (`owner` names the holder) — back off, do NOT open a duplicate lane.",
	parameters: Schema.Struct({resource: Schema.NonEmptyString}),
	success: Messages.ClaimReply,
});

/** The claim toolkit — registered on the session's one served `McpServer` alongside `channel_send`. */
export const ClaimToolkit = Toolkit.make(ClaimResource);

/** The toolkit handler: route the claim through the `ChannelClaim` port (the session's tracker claim). */
export const claimToolHandlers = ClaimToolkit.toLayer(
	Effect.gen(function* () {
		const claimer = yield* ChannelClaim;
		return {
			channel_claim: ({resource}) => claimer.claim(resource),
		};
	}),
);
