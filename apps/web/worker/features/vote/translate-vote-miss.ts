/**
 * The single home for the inline voter's "a `Vote` miss is *this* caller's not-found"
 * rule (ADR 0016). The divan path is deliberately NOT a caller — it has its own one-arm
 * `castOnSandboxed → Denied` translation.
 */
import {Effect} from "effect";
import type {VoterNotEligible, VoteTargetNotFound, VoteTargetSandboxed} from "./errors.ts";

/** `makeNotFound` is a thunk so each failure raises a fresh error. */
export const translateVoteMiss =
	<E>(makeNotFound: () => E) =>
	<A, R>(
		self: Effect.Effect<A, VoteTargetNotFound | VoteTargetSandboxed | VoterNotEligible, R>,
	): Effect.Effect<A, E | VoterNotEligible, R> =>
		self.pipe(
			// `VoterNotEligible` (#1810) is deliberately absent: it is a genuine REJECTION, not a
			// miss, and must pass through untranslated — a çaylak has to see "vote once promoted",
			// not "this doesn't exist".
			Effect.catchTags({
				"vote/VoteTargetNotFound": () => Effect.fail(makeNotFound()),
				"vote/VoteTargetSandboxed": () => Effect.fail(makeNotFound()),
			}),
		);
