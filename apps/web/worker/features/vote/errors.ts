/**
 * Tagged errors raised by the Vote service layer.
 *
 * `VoteTargetNotFound` carries NO `FateWireCode` by design: it never reaches the
 * wire. Consuming services translate it at their own boundary via
 * `Effect.catchTag` (→ `DefinitionNotFound` / `PostNotFound` / `CommentNotFound`),
 * so fate handlers only ever emit the feature-level not-found errors.
 */
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
