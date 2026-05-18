/**
 * Tagged errors raised by the Vote service layer.
 *
 * Wire-code contract — every tag in this file maps to a specific
 * `extensions.code` string via `worker/graphql/errors.ts::encodeMutationError`:
 *
 *   vote/VoteTargetNotFound → VOTE_TARGET_NOT_FOUND
 *
 * Mirrors the legacy `VoteTargetNotFoundError` (in `vote/module.ts`) shape:
 * the resolver-facing wire code is unchanged so the SPA continues to
 * pattern-match the same string. The old class-form error stays on the legacy
 * `vote()` async function until Task 5 (Pano migration) deletes it.
 */
import {Data} from "effect";
import type {VoteTargetKind} from "./Vote";

export class VoteTargetNotFound extends Data.TaggedError("vote/VoteTargetNotFound")<{
	readonly targetKind: VoteTargetKind;
	readonly targetId: string;
	readonly message: string;
}> {}
