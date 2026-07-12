/**
 * Tagged errors raised by the Reaction service layer.
 *
 * `ReactionTargetNotFound` carries NO `FateWireCode` by design (the
 * {@link ../vote/errors.ts VoteTargetNotFound} twin): it never reaches the wire.
 * A consuming service translates it at its own boundary via `Effect.catchTag`
 * (→ `DefinitionNotFound` / `PostNotFound` / `CommentNotFound`), so fate
 * handlers only ever emit the feature-level not-found errors.
 *
 * There is deliberately NO voter-tier / sandbox error here — reactions are
 * ungated and karma-free (the settled divergence from Vote, #1861): any
 * authenticated user, including a çaylak newcomer, may react. The only failure
 * mode is a missing/removed target; a non-palette emoji is rejected structurally
 * by `ReactionEmojiSchema` at the wire boundary, not by a service error.
 */
import * as Schema from "effect/Schema";
import {TargetKindSchema} from "../../db/target-kind.ts";
import {TargetId} from "../../lib/ids.ts";

export class ReactionTargetNotFound extends Schema.TaggedErrorClass<ReactionTargetNotFound>()(
	"reaction/ReactionTargetNotFound",
	{
		targetKind: TargetKindSchema,
		targetId: TargetId,
		message: Schema.String,
	},
) {}
