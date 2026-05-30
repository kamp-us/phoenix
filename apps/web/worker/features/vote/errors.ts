/**
 * Tagged errors raised by the Vote service layer.
 *
 * Wire-code contract — every tag in this file maps to a specific
 * `code` string via `worker/features/fate/errors.ts::encodeFateError`:
 *
 *   vote/VoteTargetNotFound → VOTE_TARGET_NOT_FOUND
 *
 * Replaces the pre-effect-migration `VoteTargetNotFoundError` class-form
 * error; wire code preserved verbatim so SPA pattern-matching keeps working.
 */
import {Data} from "effect";

/**
 * The three polymorphic vote targets in the system. Lives here (alongside the
 * error that references it) rather than in `Vote.ts` to keep the
 * `Vote.ts → errors.ts` import edge one-way — moving it the other direction
 * creates a circular import that tsgo refuses to resolve even with
 * `import type`.
 */
export type VoteTargetKind = "definition" | "post" | "comment";

export class VoteTargetNotFound extends Data.TaggedError("vote/VoteTargetNotFound")<{
	readonly targetKind: VoteTargetKind;
	readonly targetId: string;
	readonly message: string;
}> {}
