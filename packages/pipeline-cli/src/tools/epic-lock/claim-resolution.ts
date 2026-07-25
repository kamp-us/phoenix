/**
 * The pure claim-resolution core of `epic-lock` — IO-free, total, unit-testable.
 *
 * The single decision the `plan-epic` / `review-plan` / `write-code` skills each
 * hand-rolled inline (~50 lines of jq apiece): given the raw claim comments on an
 * epic, the write+ authorized-author set, and our own session id, decide the one
 * lock holder. The holder is the **earliest authorized claim** — the minimum
 * `(created_at, comment id)` (ADR 0115 §2) — among comments whose body matches the
 * canonical `CLAIM_RE` and whose author holds write+ on the repo (the ADR 0055
 * trust root). A forged claim from a non-collaborator is dropped before the
 * tiebreak; an empty authorized set resolves NO winner (fail-closed, never a false
 * win); a missing session id is its own fail-closed outcome. The contract — the
 * marker grammar, the `CLAIM_RE`, and the tiebreak — is single-sourced in
 * gh-issue-intake-formats.md §7 (see ADR 0115); this core is the deterministic
 * decision the IO shell (`github.ts`) drives.
 */

/**
 * The canonical claim marker (gh-issue-intake-formats.md §7): one anchored,
 * emphasis-tolerant line; the embedded session id is captured in group 1. The
 * `\**` absorbs any leading bold-marker, `[0-9a-f-]{36}` matches a session UUID.
 */
export const CLAIM_RE = /^\s*\**\s*claim:\s*([0-9a-f-]{36})\b/i;

/**
 * Compose a claim marker body: the canonical `claim: <session> · <ts>` line, plus the optional
 * `· presence <host>/<pid>` suffix that makes the claimant's liveness machine-checkable
 * (`claim-presence.ts`). The grammar lives here so no writer hand-concatenates it.
 */
export const claimCommentBody = (
	session: string,
	at: string,
	presenceSuffix?: string | null,
): string => `claim: ${session} · ${at}${presenceSuffix ? ` · ${presenceSuffix}` : ""}`;

/** A claim comment as the issues/comments REST endpoint surfaces it (only these fields matter). */
export interface ClaimComment {
	/** Server-assigned, strictly-monotonic, globally-unique comment id (the tiebreak sub-key). */
	readonly id: number;
	/** The comment author's login (checked against the authorized set). */
	readonly author: string;
	/** ISO-8601 UTC creation time (the tiebreak primary key). */
	readonly createdAt: string;
	/** The raw comment body (matched against `CLAIM_RE`). */
	readonly body: string;
}

/** Parse the embedded session id out of a claim-comment body, or `null` if it is not a claim. */
export const parseClaimSession = (body: string): string | null => {
	const session = CLAIM_RE.exec(body)?.[1];
	return session ? session.toLowerCase() : null;
};

/**
 * A claimant's presence — the ADR 0191 liveness of the claim, resolved from the marker's
 * optional presence stamp by the IO shell. `dead` is the ONLY value that supersedes a claim,
 * and it requires positive evidence (the stamped session process is provably gone on this
 * machine); `unknown` (no stamp, another machine, an unresolvable local machine identity, an
 * unprobeable pid) counts as a live claim, so doubt refuses rather than evicts.
 */
export type ClaimLiveness = "live" | "dead" | "unknown";

export interface ClaimResolutionInput {
	readonly comments: ReadonlyArray<ClaimComment>;
	/** The write+ collaborator logins — the ADR 0055 trust root (resolved by the IO shell). */
	readonly authorizedAuthors: ReadonlyArray<string>;
	/** Our own `CLAUDE_CODE_SESSION_ID`; absent/empty ⇒ fail-closed `no-session`. */
	readonly sessionId: string | null | undefined;
	/**
	 * Per-comment-id claimant liveness (`claim-presence.ts` resolves it). A comment absent
	 * from the map is `unknown` ⇒ its claim counts, so omitting the map entirely reproduces
	 * the pre-supersession resolution exactly.
	 */
	readonly liveness?: ReadonlyMap<number, ClaimLiveness> | undefined;
}

/** The resolved lock holder — the earliest authorized claim. */
export interface ClaimWinner {
	readonly session: string;
	readonly id: number;
	readonly createdAt: string;
}

export type ClaimOutcome =
	| {readonly _tag: "no-session"}
	| {readonly _tag: "no-winner"}
	| {readonly _tag: "won"; readonly winner: ClaimWinner}
	| {readonly _tag: "lost"; readonly winner: ClaimWinner};

/** Every authorized claim on the target, ordered earliest-first by `(createdAt, id)`. */
const authorizedClaims = (
	comments: ReadonlyArray<ClaimComment>,
	authorizedAuthors: ReadonlyArray<string>,
): ReadonlyArray<ClaimWinner> => {
	const authorized = new Set(authorizedAuthors);
	const claims: ClaimWinner[] = [];
	for (const comment of comments) {
		if (!authorized.has(comment.author)) continue;
		const session = parseClaimSession(comment.body);
		if (session === null) continue;
		claims.push({session, id: comment.id, createdAt: comment.createdAt});
	}
	claims.sort((a, b) =>
		a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
	);
	return claims;
};

/**
 * The earliest **live-or-indeterminate** authorized claim — min `(createdAt, id)` — among
 * comments that both match `CLAIM_RE` and are authored by a write+ collaborator. Returns
 * `null` when no such claim exists (empty authorized set, only forged/non-claim comments, or
 * every authorized claim superseded): an empty result is the fail-closed "no owner", never a
 * false win.
 *
 * A claim whose claimant is **provably dead** (`liveness` says `dead` — ADR 0191 presence
 * liveness, positive evidence only) is **superseded**: it drops out of the tiebreak so a
 * later legitimate claim on an abandoned lane can win, which is what makes the mis-attribution
 * guard runnable under orchestrated repair instead of shadowed forever by a dead session's
 * older marker (#3751). Every other liveness value counts the claim, so an indeterminate
 * claimant still wins the tiebreak and the reader still refuses — doubt never evicts a
 * slow-but-live agent (the hazard ADR 0115 §5's deferral was protecting).
 */
export const resolveWinner = (
	comments: ReadonlyArray<ClaimComment>,
	authorizedAuthors: ReadonlyArray<string>,
	liveness?: ReadonlyMap<number, ClaimLiveness> | undefined,
): ClaimWinner | null =>
	authorizedClaims(comments, authorizedAuthors).find(
		(claim) => liveness?.get(claim.id) !== "dead",
	) ?? null;

/**
 * The authorized claims **dropped as superseded** by the liveness projection — the audit
 * trail a caller logs next to the resolved winner ("#N: superseded 1 dead-claimant claim").
 * Kept as its own read rather than folded into `ClaimOutcome` so the outcome shape (and every
 * consumer that pattern-matches it) is untouched.
 */
export const supersededClaims = (
	comments: ReadonlyArray<ClaimComment>,
	authorizedAuthors: ReadonlyArray<string>,
	liveness?: ReadonlyMap<number, ClaimLiveness> | undefined,
): ReadonlyArray<ClaimWinner> =>
	authorizedClaims(comments, authorizedAuthors).filter(
		(claim) => liveness?.get(claim.id) === "dead",
	);

/**
 * Decide our win/lose against canonical epic state. Fail-closed twice over: a
 * missing session id is `no-session` (we have no agent-distinguishable identity to
 * resolve under), and an empty authorized claim set is `no-winner` (nothing proven
 * to hold). A real winner whose session equals ours is `won`; any other winner is
 * `lost` — defer to the holder, never evict.
 */
export const resolveClaim = (input: ClaimResolutionInput): ClaimOutcome => {
	if (!input.sessionId) return {_tag: "no-session"};
	const winner = resolveWinner(input.comments, input.authorizedAuthors, input.liveness);
	if (winner === null) return {_tag: "no-winner"};
	return winner.session === input.sessionId.toLowerCase()
		? {_tag: "won", winner}
		: {_tag: "lost", winner};
};

/**
 * The ids of our *own* claim comments (matched by session id) — the exact set
 * `release` retracts. Our session may have posted more than one across retried
 * acquires, so this returns all of them.
 */
export const ownClaimCommentIds = (
	comments: ReadonlyArray<ClaimComment>,
	sessionId: string,
): ReadonlyArray<number> => {
	const mine = sessionId.toLowerCase();
	return comments.filter((comment) => parseClaimSession(comment.body) === mine).map((c) => c.id);
};
