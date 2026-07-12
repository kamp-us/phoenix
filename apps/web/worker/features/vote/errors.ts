/**
 * Tagged errors raised by the Vote service layer.
 *
 * `VoteTargetNotFound` carries NO `FateWireCode` by design: it never reaches the
 * wire. Consuming services translate it at their own boundary via
 * `Effect.catchTag` (→ `DefinitionNotFound` / `PostNotFound` / `CommentNotFound`),
 * so fate handlers only ever emit the feature-level not-found errors.
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
 * The target is **sandboxed** (a çaylak's not-yet-promoted content, ADR 0096 §sandbox)
 * and the cast came through the ordinary `Vote.cast` surface, which is not authorized to
 * score sandboxed content. A sandboxed item is votable ONLY through `Vote.castOnSandboxed`,
 * reached past the divan gate (`features/divan`, #1287/#1288). Carries no `FateWireCode`
 * for the same reason as {@link VoteTargetNotFound}: a consuming inline service translates
 * it at its own boundary (→ `DefinitionNotFound` / `PostNotFound` / `CommentNotFound`), so a
 * sandboxed item simply reads as not-found to a non-divan voter.
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
 * The tier a voter must reach to cast on live content ("earn to vote", #1810) — the SINGLE
 * source both the {@link VoterNotEligible} wire code and its `need` field derive from, so the
 * tier name and the wire code can't drift apart across sites. The rejection's rank name lives
 * ONCE here: `Vote.castImpl` reads it for `VoterNotEligible.need` (it no longer re-bakes a raw
 * `"yazar"` string), and {@link VOTE_ELIGIBILITY_WIRE_CODE} is derived from it — a ladder move
 * (a new required rank) is a one-token edit here that moves the `need` field and the wire code
 * together, never an edit that touches Vote's internals.
 */
export const VOTE_REQUIRED_TIER = "yazar" as const;

/**
 * The `FateWireCode` for {@link VoterNotEligible}, DERIVED from {@link VOTE_REQUIRED_TIER} so
 * the required-tier name and the wire code are one fact, not two that can drift. Distinct from
 * the overloaded `FORBIDDEN` (künye vouch denials) so the vote gate carries its own ladder copy
 * ("yazar olunca oy verebilirsin") without recopying `FORBIDDEN` and mislabelling those (#1879).
 * With `VOTE_REQUIRED_TIER = "yazar"` this is the literal `"VOTE_REQUIRES_YAZAR"` the SPA copy
 * (`src/fate/wireMessages.ts`) and the fate wire-code allowlist already decode.
 */
export const VOTE_ELIGIBILITY_WIRE_CODE =
	`VOTE_REQUIRES_${VOTE_REQUIRED_TIER.toUpperCase()}` as const;

/**
 * The **voter** is not yet eligible to cast — their account tier is at or below the
 * çaylak newcomer floor, and voting on live content is an earned privilege ("earn to
 * vote", the #1810 containment). Unlike {@link VoteTargetSandboxed} (a *target*-liveness
 * gate that reads as not-found), this is a *voter*-tier rejection and DOES reach the wire
 * as a visible {@link VOTE_ELIGIBILITY_WIRE_CODE} — the same "the ladder is a visible
 * progression" idiom as `kunye/RequiresLevel`, so a çaylak sees a clear "vote once promoted"
 * denial rather than a silent no-op or a mislabelled not-found. Carries the `need`ed tier
 * ({@link VOTE_REQUIRED_TIER}) so the surface can name the bar. The gate is the SINGLE choke
 * point in `Vote.castImpl` (the `requireVoterTier` regime), covering all three inline cast
 * paths — pano post/comment + sözlük definition — and is NOT applied on the divan-authorized
 * `castOnSandboxed` path (a yazar/mod is already above the floor and the divan gate is the
 * authorization there, #1288).
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
 * A voter tried to cast on their **own** content (`voterId === authorId`), which the
 * founder has ruled disallowed — a self-vote inflates the author's own score/karma and
 * corrupts every ranking that reads it (#2216). Like {@link VoterNotEligible} this is a
 * genuine *voter* rejection that reaches the wire (its own `SELF_VOTE_NOT_ALLOWED`
 * {@link FateWireCode}, so the SPA can name it), never a target miss. Raised at the cast
 * site (`Pano.applyPostVote` / `Sozluk.applyVote`), which already holds the target's
 * `authorId` — and only on the CAST direction (`isVote === true`): a retraction is exempt,
 * since once the cast is blocked there is no self-vote to retract (the same cast-only shape
 * as {@link VoterNotEligible}).
 */
export class SelfVoteNotAllowed extends Schema.TaggedErrorClass<SelfVoteNotAllowed>()(
	"vote/SelfVoteNotAllowed",
	{
		// Unbranded `Schema.String` (unlike VoterNotEligible's `UserId`) on purpose:
		// this error is constructed at each feature's own self-vote guard — pano
		// (post/comment) and sözlük — not inside Vote. Until those features brand
		// their voter id (pano #2713), a `UserId` here would fail repo-wide typecheck
		// at the pano call sites, which the epic #2700 forbids (#2723 stays vote-local).
		voterId: Schema.String,
		message: Schema.String,
	},
	{[FateWireCode]: "SELF_VOTE_NOT_ALLOWED"},
) {}
