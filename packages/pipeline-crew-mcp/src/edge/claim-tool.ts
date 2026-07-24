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
 *
 * Keyspace caveat — one lane has TWO keys (#3796 facet 1). A build lane is named by BOTH its issue
 * number AND, later, the PR number that comes out of it, but the tracker keys claims on an opaque
 * exact-match `resource`, so it cannot know `3686` (the issue) and `3713` (its PR) denote one lane —
 * claiming one does NOT reserve the other, and two engines that claim different keys for the same
 * lane both get `granted`. Until a canonical lane identity lands (the structural fix belongs to epic
 * #3766's planning), the interim convention — stated on the tool below so an engine reads it at claim
 * time — is: claim BOTH keys, the issue at dispatch and the PR the moment it opens. With both keys
 * held by the first engine, the second claimant of EITHER key gets `collision: true`.
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
		"Claim a resource (an issue or PR id) against the tracker before opening a build lane; returns " +
		"the typed reply. `granted: true` ⇒ you now hold the lane; `collision: true` ⇒ another engine " +
		"already holds it (`owner` names the holder) — back off, do NOT open a duplicate lane. One lane " +
		"has TWO keys the tracker cannot link (the issue AND its PR number), so claim BOTH: the issue " +
		"at dispatch, and the PR the moment it opens — else another engine can claim the other key for " +
		"the same lane and also get granted. Release a key you no longer need with channel_release.",
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
