/**
 * The pure release decision — which claim comments a finished run may retract, IO-free and total.
 *
 * Release is the **affirmative** half of a claim's lifetime: a claim ends because its owner says
 * its work is done, never because a reader inferred the owner is gone. That asymmetry is the
 * design, not an implementation detail. Inference from absence is what a claim-lifetime rule must
 * not do — an age/TTL bound evicts a slow-but-live agent (the hazard ADR 0115 §5 deferred reclaim
 * over), and "the claiming session id is not the current session id" is not evidence of completion
 * either, because a live process can rotate its session id mid-run (#4045). So release retracts
 * **only** markers carrying the token the caller owns; every other claim is `kept` — whatever its
 * age, its liveness, or whether it carries a presence stamp at all (#3780).
 *
 * This introduces no second claim keyspace: the comments released here are the same `CLAIM_RE`
 * markers `resolveWinner` resolves over (gh-issue-intake-formats.md §7), so a released claim
 * simply stops being an owner — the one resolution stays the one resolution.
 */
import {
	type ClaimComment,
	type ClaimWinner,
	parseClaimSession,
} from "../epic-lock/claim-resolution.ts";

/** What a release will and will not touch — the decision the IO shell executes and the command reports. */
export interface ReleasePlan {
	/** The comment ids to DELETE: exactly the markers carrying our own token. */
	readonly retract: ReadonlyArray<number>;
	/**
	 * Every claim marker left standing because it is not ours. Reported, not evicted: naming them
	 * is what makes "release freed the lane but #N is still claimed" answerable from the run log.
	 */
	readonly kept: ReadonlyArray<ClaimWinner>;
}

const asWinner = (comment: ClaimComment, session: string): ClaimWinner => ({
	session,
	id: comment.id,
	createdAt: comment.createdAt,
});

/**
 * Split an issue's claim markers into ours (retractable) and everyone else's (kept). A missing
 * session id retracts nothing and keeps everything — with no token there is no claim we can prove
 * is ours, and guessing one would be an eviction (the command turns this into a loud refusal).
 */
export const releasePlan = (
	comments: ReadonlyArray<ClaimComment>,
	sessionId: string | null | undefined,
): ReleasePlan => {
	const mine = sessionId?.trim().toLowerCase() ?? "";
	const retract: number[] = [];
	const kept: ClaimWinner[] = [];
	for (const comment of comments) {
		const session = parseClaimSession(comment.body);
		if (session === null) continue;
		if (mine !== "" && session === mine) retract.push(comment.id);
		else kept.push(asWinner(comment, session));
	}
	return {retract, kept};
};
