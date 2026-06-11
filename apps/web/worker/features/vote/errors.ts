/**
 * Tagged errors raised by the Vote service layer.
 *
 * `VoteTargetNotFound` carries NO `WireCode` annotation by design: it
 * never reaches the wire. The consuming services translate it at their own
 * boundary (`Sozluk.vote.cast` → `DefinitionNotFound`, `Pano.post.vote` →
 * `PostNotFound`, `Pano.comment.vote` → `CommentNotFound`, all via
 * `Effect.catchTag`), so fate handlers only ever declare — and emit — the
 * feature-level not-found errors.
 */
import * as Schema from "effect/Schema";

/**
 * The three polymorphic vote targets in the system. Lives here (alongside the
 * error that references it) rather than in `Vote.ts` to keep the
 * `Vote.ts → errors.ts` import edge one-way — moving it the other direction
 * creates a circular import that tsgo refuses to resolve even with
 * `import type`.
 */
export type VoteTargetKind = "definition" | "post" | "comment";

export class VoteTargetNotFound extends Schema.TaggedErrorClass<VoteTargetNotFound>()(
	"vote/VoteTargetNotFound",
	{
		targetKind: Schema.Literals(["definition", "post", "comment"]),
		targetId: Schema.String,
		message: Schema.String,
	},
) {}
