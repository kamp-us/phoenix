/**
 * Tagged errors raised by the Vote service layer.
 *
 * `VoteTargetNotFound` carries NO `ErrorCode` by design: it never reaches the
 * wire. Consuming services translate it at their own boundary via
 * `Effect.catchTag` (→ `DefinitionNotFound` / `PostNotFound` / `CommentNotFound`),
 * so fate handlers only ever emit the feature-level not-found errors.
 */
import * as Schema from "effect/Schema";

// Lives here, not in `Vote.ts`, to keep the `Vote.ts → errors.ts` edge one-way:
// the reverse direction is a cycle tsgo refuses to resolve even with `import type`.
export type VoteTargetKind = "definition" | "post" | "comment";

export class VoteTargetNotFound extends Schema.TaggedErrorClass<VoteTargetNotFound>()(
	"vote/VoteTargetNotFound",
	{
		targetKind: Schema.Literals(["definition", "post", "comment"]),
		targetId: Schema.String,
		message: Schema.String,
	},
) {}
