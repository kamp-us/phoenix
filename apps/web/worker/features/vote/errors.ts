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
