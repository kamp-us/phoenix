/**
 * Which in-repo paths a doc cites, and what the citation set means once each has been followed.
 *
 * **An unresolved candidate is never drift, and never a finding.** Pattern prose legitimately cites
 * external dependency source trees, and such a path is indistinguishable from a deleted in-repo path
 * by resolution alone — the irreducible false-positive source that made `pipeline-guard` exclude
 * `.patterns/**` outright. Candidates that do not resolve are counted, named on stderr, and excluded
 * from the moved set and from the outcome. This inherits that avoidance rather than repeating the
 * defect.
 */

/** Characters that make a token a glob, a template or prose furniture rather than a path. */
const AMBIGUOUS = /[*?{}[\]!()<>$|]/;

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Every backticked span and every markdown link target in `text`, as whitespace-free tokens.
 *
 * A span carrying whitespace is not one token, so it is not a candidate — which is also what keeps
 * a fenced block's contents from arriving here as a path.
 */
export const candidateTokens = (text: string): ReadonlyArray<string> => {
	const found: string[] = [];
	const push = (raw: string | undefined) => {
		if (raw === undefined) return;
		const token = raw.trim();
		if (token !== "" && !/\s/.test(token) && !found.includes(token)) found.push(token);
	};
	for (const m of text.matchAll(/`([^`]+)`/g)) push(m[1]);
	for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) push(m[1]);
	return found;
};

/**
 * Whether a candidate is an unambiguous repo-root-relative path.
 *
 * The top-level segment set is **read from the tree**, never hardcoded, so the verb works in a repo
 * whose layout is not this one. A bare basename and an app-relative fragment are ambiguous shorthand
 * and are left alone — precision over recall, at the stated cost of missing a partial pointer.
 */
export const isRepoPath = (token: string, topLevel: ReadonlySet<string>): boolean => {
	if (AMBIGUOUS.test(token) || SCHEME.test(token)) return false;
	const first = token.split("/")[0];
	return first !== undefined && first !== "" && topLevel.has(first);
};

/** `unborn` per the doc's tree state, then the moved set, then whether anything was followed. */
export type DriftOutcome = "drifted" | "current" | "unanchored" | "unborn";

/**
 * **`unanchored` is not a clearance.** It says the doc cites nothing this verb can follow, so drift
 * is *unanswerable* — read the source by hand. Reporting it as `current` would be a clean pass over
 * nothing, which is the shape ADR 0092 exists to forbid; the group expresses that in vocabulary
 * rather than in an exit code, because a verb that refused would break the pipe its answer crosses.
 */
export const driftOutcome = (input: {
	readonly inRepo: number;
	readonly moved: number;
}): Exclude<DriftOutcome, "unborn"> => {
	if (input.inRepo === 0) return "unanchored";
	return input.moved > 0 ? "drifted" : "current";
};
