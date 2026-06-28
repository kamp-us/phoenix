/**
 * `translateVoteMiss` — the single home for the inline voter's "a `Vote` miss is
 * *this* caller's not-found" rule.
 *
 * The ordinary `Vote.cast` surface fails two ways that an inline voter
 * (sözlük/pano) must surface as its own feature not-found: `VoteTargetNotFound`
 * (a raced soft-delete) and `VoteTargetSandboxed` (a çaylak's not-yet-promoted
 * content, which only the divan-gated `castOnSandboxed` path may score, #1288).
 * To a non-divan voter both read as "not there", so both collapse to the
 * caller's `*NotFound`. This combinator maps that two-arm union to a
 * caller-supplied not-found thunk once, replacing the byte-identical inline
 * `catchTags` blocks in `Sozluk.applyVote` / `Pano.applyPostVote` /
 * `Pano.applyCommentVote`. A new `Vote` error tag is now a one-line change here.
 *
 * The divan path (`features/divan`) is deliberately NOT a caller: it uses the
 * one-arm `castOnSandboxed → Denied` translation (different method, single tag,
 * opaque target), so it stays out of this two-arm combinator.
 *
 * See ADR 0016 (resolvers translate failures to wire codes at the boundary).
 */
import {Effect} from "effect";
import type {VoteTargetNotFound, VoteTargetSandboxed} from "./errors.ts";

/**
 * Map the two-arm `Vote` miss union (`VoteTargetNotFound` + `VoteTargetSandboxed`),
 * the exact error channel of `Vote.cast`, to a caller-supplied not-found error.
 * `makeNotFound` is a thunk so each failure raises a fresh error.
 */
export const translateVoteMiss =
	<E>(makeNotFound: () => E) =>
	<A, R>(
		self: Effect.Effect<A, VoteTargetNotFound | VoteTargetSandboxed, R>,
	): Effect.Effect<A, E, R> =>
		self.pipe(
			Effect.catchTags({
				"vote/VoteTargetNotFound": () => Effect.fail(makeNotFound()),
				"vote/VoteTargetSandboxed": () => Effect.fail(makeNotFound()),
			}),
		);
