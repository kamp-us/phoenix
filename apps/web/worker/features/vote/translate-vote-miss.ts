/**
 * `translateVoteMiss` — the single home for the inline voter's "a `Vote` miss is
 * *this* caller's not-found" rule.
 *
 * The ordinary `Vote.cast` surface fails three ways an inline voter (sözlük/pano)
 * sees. Two are "not there" MISSES that collapse to this caller's own feature
 * not-found: `VoteTargetNotFound` (a raced soft-delete) and `VoteTargetSandboxed`
 * (a çaylak's not-yet-promoted content, which only the divan-gated
 * `castOnSandboxed` path may score, #1288). This combinator maps that two-arm
 * miss union to a caller-supplied not-found thunk once, replacing the
 * byte-identical inline `catchTags` blocks in `Sozluk.applyVote` /
 * `Pano.applyPostVote` / `Pano.applyCommentVote`. A new `Vote` MISS tag is a
 * one-line change here.
 *
 * The third — `VoterNotEligible` (#1810's "earn to vote" gate) — is NOT a miss: a
 * çaylak voter is genuinely REJECTED, so it passes through UNTRANSLATED and reaches
 * the wire as `FORBIDDEN`. It stays in the combinator's output channel (`E |
 * VoterNotEligible`) deliberately — collapsing it to not-found would mislabel a
 * "vote once promoted" denial as "this doesn't exist".
 *
 * The divan path (`features/divan`) is deliberately NOT a caller: it uses the
 * one-arm `castOnSandboxed → Denied` translation (different method, single tag,
 * opaque target), so it stays out of this two-arm combinator.
 *
 * See ADR 0016 (resolvers translate failures to wire codes at the boundary).
 */
import {Effect} from "effect";
import type {VoterNotEligible, VoteTargetNotFound, VoteTargetSandboxed} from "./errors.ts";

/**
 * Map the two-arm `Vote` miss union (`VoteTargetNotFound` + `VoteTargetSandboxed`),
 * the exact error channel of `Vote.cast`, to a caller-supplied not-found error.
 * `makeNotFound` is a thunk so each failure raises a fresh error.
 */
export const translateVoteMiss =
	<E>(makeNotFound: () => E) =>
	<A, R>(
		self: Effect.Effect<A, VoteTargetNotFound | VoteTargetSandboxed | VoterNotEligible, R>,
	): Effect.Effect<A, E | VoterNotEligible, R> =>
		self.pipe(
			// Only the two "not there" arms collapse to the caller's not-found. `VoterNotEligible`
			// (#1810's "earn to vote" gate) is a genuine REJECTION, not a miss — it passes through
			// UNTRANSLATED so the resolver surfaces its wire `FORBIDDEN`, never a mislabelled
			// not-found (a çaylak must see "vote once promoted", not "this doesn't exist").
			Effect.catchTags({
				"vote/VoteTargetNotFound": () => Effect.fail(makeNotFound()),
				"vote/VoteTargetSandboxed": () => Effect.fail(makeNotFound()),
			}),
		);
