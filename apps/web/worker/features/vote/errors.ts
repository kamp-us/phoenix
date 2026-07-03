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

export class VoteTargetNotFound extends Schema.TaggedErrorClass<VoteTargetNotFound>()(
	"vote/VoteTargetNotFound",
	{
		targetKind: TargetKindSchema,
		targetId: Schema.String,
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
		targetId: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * The **voter** is not yet eligible to cast — their account tier is at or below the
 * çaylak newcomer floor, and voting on live content is an earned privilege ("earn to
 * vote", the #1810 containment). Unlike {@link VoteTargetSandboxed} (a *target*-liveness
 * gate that reads as not-found), this is a *voter*-tier rejection and DOES reach the wire
 * as a visible `VOTE_REQUIRES_YAZAR` — the same "the ladder is a visible progression" idiom
 * as `kunye/RequiresLevel`, so a çaylak sees a clear "vote once promoted" denial rather than
 * a silent no-op or a mislabelled not-found. The code is DISTINCT from the overloaded
 * `FORBIDDEN` (künye vouch denials) so the vote gate carries its own ladder copy ("yazar
 * olunca oy verebilirsin") without recopying `FORBIDDEN` and mislabelling those (#1879).
 * Carries the `need`ed tier so the surface can name
 * the bar. The gate is the SINGLE choke point in `Vote.castImpl` (the `requireVoterTier`
 * regime), covering all three inline cast paths — pano post/comment + sözlük definition —
 * and is NOT applied on the divan-authorized `castOnSandboxed` path (a yazar/mod is already
 * above the floor and the divan gate is the authorization there, #1288).
 */
export class VoterNotEligible extends Schema.TaggedErrorClass<VoterNotEligible>()(
	"vote/VoterNotEligible",
	{
		voterId: Schema.String,
		need: Schema.String,
		message: Schema.String,
	},
	{[FateWireCode]: "VOTE_REQUIRES_YAZAR"},
) {}
