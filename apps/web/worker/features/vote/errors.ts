/**
 * Tagged errors raised by the Vote service layer.
 *
 * `VoteTargetNotFound` carries NO `FateWireCode` by design: it never reaches the wire.
 * Consuming services translate it at their own boundary, so fate handlers only ever emit
 * the feature-level not-found errors.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";
import {TargetKindSchema} from "../../db/target-kind.ts";
import {TargetId, UserId} from "../../lib/ids.ts";

export class VoteTargetNotFound extends Schema.TaggedErrorClass<VoteTargetNotFound>()(
	"vote/VoteTargetNotFound",
	{
		targetKind: TargetKindSchema,
		targetId: TargetId,
		message: Schema.String,
	},
) {}

/**
 * A sandboxed target is votable ONLY through `Vote.castOnSandboxed`, past the divan gate
 * (#1287/#1288). Carries no `FateWireCode` for the same reason as {@link VoteTargetNotFound},
 * so a sandboxed item simply reads as not-found to a non-divan voter.
 */
export class VoteTargetSandboxed extends Schema.TaggedErrorClass<VoteTargetSandboxed>()(
	"vote/VoteTargetSandboxed",
	{
		targetKind: TargetKindSchema,
		targetId: TargetId,
		message: Schema.String,
	},
) {}

/**
 * The tier a voter must reach to cast on live content ("earn to vote", #1810). The SINGLE
 * source both {@link VoterNotEligible}'s `need` field and its wire code derive from, so a
 * ladder move is a one-token edit here.
 */
export const VOTE_REQUIRED_TIER = "yazar" as const;

/**
 * Derived from {@link VOTE_REQUIRED_TIER}, and deliberately distinct from the overloaded
 * `FORBIDDEN` so the vote gate carries its own ladder copy without mislabelling künye's
 * denials (#1879). Today it is the literal `"VOTE_REQUIRES_YAZAR"` the SPA copy and the
 * fate wire-code allowlist decode.
 */
export const VOTE_ELIGIBILITY_WIRE_CODE =
	`VOTE_REQUIRES_${VOTE_REQUIRED_TIER.toUpperCase()}` as const;

/**
 * The voter's tier is below the bar (#1810). Unlike {@link VoteTargetSandboxed}, this DOES
 * reach the wire: the ladder is a visible progression, so a çaylak sees a "vote once
 * promoted" denial rather than a silent no-op or a mislabelled not-found. Enforced at the
 * single choke point in `Vote.castImpl`, and NOT on the divan-authorized `castOnSandboxed`
 * path (the divan gate is the authorization there, #1288).
 */
export class VoterNotEligible extends Schema.TaggedErrorClass<VoterNotEligible>()(
	"vote/VoterNotEligible",
	{
		voterId: UserId,
		need: Schema.String,
		message: Schema.String,
	},
	{[FateWireCode]: VOTE_ELIGIBILITY_WIRE_CODE},
) {}

/**
 * A cast on one's own content, founder-ruled disallowed because a self-vote inflates the
 * author's own score and corrupts every ranking reading it (#2216). Raised at the feature
 * cast sites, which already hold the target's `authorId`, and only on the CAST direction:
 * a blocked cast leaves no self-vote to retract.
 */
export class SelfVoteNotAllowed extends Schema.TaggedErrorClass<SelfVoteNotAllowed>()(
	"vote/SelfVoteNotAllowed",
	{
		// Unbranded on purpose (unlike VoterNotEligible's `UserId`): until pano brands its
		// voter id (#2713), a `UserId` here fails typecheck at the pano call sites.
		voterId: Schema.String,
		message: Schema.String,
	},
	{[FateWireCode]: "SELF_VOTE_NOT_ALLOWED"},
) {}
