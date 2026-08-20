/**
 * `ReactionTargetNotFound` carries NO `FateWireCode` by design: it never reaches the
 * wire — a consuming service translates it at its own boundary.
 *
 * There is deliberately NO voter-tier or sandbox error here. Reactions are ungated and
 * karma-free (the settled divergence from Vote, #1861), so any authenticated user
 * including a çaylak may react.
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
