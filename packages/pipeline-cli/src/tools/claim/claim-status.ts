/**
 * The pure claim-inventory projection — the read-only operational surface for "who holds #N, and
 * is that claim still doing anything?", IO-free and total.
 *
 * A claim that outlived its run used to be invisible: nothing listed it, so stranded lanes
 * accumulated silently until a re-dispatch read `lost` and stalled (#3780). This projection is the
 * surface an operator reads before deciding to clear one by hand. It **reports, it never evicts** —
 * every row carries the same liveness the resolver used (`live` / `dead` / `unknown`), and
 * `unknown` (unstamped, another host, unprobeable pid) is shown as exactly what it is: a claim that
 * stands. Deciding a claim is stale from what this prints is a human's call, not a rule.
 */
import {
	type ClaimComment,
	type ClaimLiveness,
	type ClaimWinner,
	parseClaimSession,
	resolveWinner,
	supersededClaims,
} from "../epic-lock/claim-resolution.ts";

/** One claim marker on the target, as an operator needs to see it. */
export interface ClaimRow {
	readonly session: string;
	readonly id: number;
	readonly createdAt: string;
	readonly author: string;
	/** Whether the author holds write+ — an unauthorized marker resolves nothing (ADR 0055). */
	readonly authorized: boolean;
	/** ADR 0191 presence liveness; `unknown` means indeterminate, which counts as a live claim. */
	readonly liveness: ClaimLiveness;
	/** Whether this marker is the resolved owner (the earliest live-or-indeterminate authorized claim). */
	readonly owner: boolean;
}

export interface ClaimStatus {
	/** The resolved owner, or `null` when nothing authorized stands — the lane is claimable. */
	readonly owner: ClaimWinner | null;
	/** Every claim marker on the target, earliest-first. */
	readonly claims: ReadonlyArray<ClaimRow>;
	/** The authorized claims dropped from the tiebreak on proven claimant death (ADR 0191). */
	readonly superseded: ReadonlyArray<ClaimWinner>;
}

export interface ClaimStatusInput {
	readonly comments: ReadonlyArray<ClaimComment>;
	readonly authorizedAuthors: ReadonlyArray<string>;
	readonly liveness?: ReadonlyMap<number, ClaimLiveness> | undefined;
}

export const claimStatus = (input: ClaimStatusInput): ClaimStatus => {
	const authorized = new Set(input.authorizedAuthors);
	const owner = resolveWinner(input.comments, input.authorizedAuthors, input.liveness);
	const claims: ClaimRow[] = [];
	for (const comment of input.comments) {
		const session = parseClaimSession(comment.body);
		if (session === null) continue;
		claims.push({
			session,
			id: comment.id,
			createdAt: comment.createdAt,
			author: comment.author,
			authorized: authorized.has(comment.author),
			liveness: input.liveness?.get(comment.id) ?? "unknown",
			owner: owner !== null && owner.id === comment.id,
		});
	}
	claims.sort((a, b) =>
		a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
	);
	return {
		owner,
		claims,
		superseded: supersededClaims(input.comments, input.authorizedAuthors, input.liveness),
	};
};
