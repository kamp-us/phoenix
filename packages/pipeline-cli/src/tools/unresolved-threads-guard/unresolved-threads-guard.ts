/**
 * The pure core of `unresolved-threads-guard` — IO-free, total, unit-testable.
 *
 * Gives ADR-0158's unresolved-inline-thread merge gate the machine teeth it lacked:
 * review-code Step 3e ("surface an unresolved thread in the verdict") was soft
 * reviewer-prose, so a review-code agent could post `PASS … merge-ready` while omitting
 * the `unresolved-threads` accounting entirely — and for a §CP PR (which banks for manual
 * merge and never touches ship-it Step 3.6, the terminal enqueue refusal) that soft prose
 * was the ONLY line of defense. That is exactly what happened on PR #3329: a CodeQL/GHAS
 * inline finding reached a human merger flagged merge-ready with no flag (#3331).
 *
 * The decision this core encodes: an unresolved inline review thread (human OR bot) is
 * unaccounted-for unless the latest authorized review-code verdict body NAMES its site
 * token (`path:line`). An unaccounted live thread reds the gate. This is polarity-blind —
 * a correctly-surfaced substantive thread lands as a `[FAIL] unresolved-threads — path:line`
 * row (accounted here; the FAIL blocks merge on its own), while a PASS that omits the row
 * (the #3329 bug) leaves the thread unaccounted → red. It does NOT re-decide ADR 0158's
 * substantive-vs-nit policy: a genuine nit is discharged the ADR-0158 way — resolve the
 * thread with a written rationale (isResolved=true removes it from the live set), never a
 * silent whole-channel skip. See ADR 0158.
 *
 * The `review-code:` marker grammar is single-sourced from `verdict-match.ts` (`namespaceRe`),
 * not re-derived; the IO shell (`github.ts`) resolves the authorized latest verdict body and
 * the PR's review threads and drives this decision at the boundary.
 */
import {namespaceRe} from "../verdict/verdict-match.ts";

/**
 * One PR review thread as ADR-0158's sanctioned GraphQL `reviewThreads` read surfaces it.
 * `line`/`path` are null for a pr-level or file-level thread; `author` is the first
 * comment's login (the bot/human that opened the thread); `excerpt` is a short slice of the
 * opening comment for the CI report.
 */
export interface ReviewThread {
	readonly isResolved: boolean;
	readonly isOutdated: boolean;
	readonly path: string | null;
	readonly line: number | null;
	readonly author: string | null;
	readonly excerpt: string;
}

/**
 * The stable site token — both the CI report's identifier and the accounting key the
 * verdict must name. `path:line` matches Step 3e's documented row format exactly; a
 * line-less thread degrades to the bare path, and a path-less (pr-level) thread to a fixed
 * sentinel that a verdict cannot coincidentally satisfy (so it fails closed as unaccounted).
 */
export const siteToken = (thread: ReviewThread): string => {
	if (thread.path === null) return "(pr-level review thread)";
	return thread.line !== null ? `${thread.path}:${thread.line}` : thread.path;
};

/**
 * The live-unresolved set — the EXACT set Step 3e's GraphQL read surfaces: `isResolved`
 * false. `isOutdated` is captured for the report but does NOT exempt a thread: the
 * ADR-0158 sanctioned read keys solely on `isResolved`, and an outdated-but-unresolved
 * thread is still an unaddressed objection until its author resolves it — inventing an
 * `isOutdated` exemption the sanctioned read doesn't make would be a silent fail-open.
 */
export const liveUnresolved = (threads: ReadonlyArray<ReviewThread>): ReadonlyArray<ReviewThread> =>
	threads.filter((thread) => !thread.isResolved);

/**
 * Is this thread accounted-for in the latest authorized review-code verdict? True iff the
 * verdict body names the thread's `siteToken`. A null body (no authorized review-code
 * verdict yet) accounts for nothing — every live thread is then unaccounted (fail-closed:
 * a PR is not merge-ready with an unresolved thread and no verdict naming it).
 */
export const isAccounted = (thread: ReviewThread, verdictBody: string | null): boolean =>
	verdictBody === null ? false : verdictBody.includes(siteToken(thread));

/** Is `body` a review-code verdict marker (its first line opens with `review-code:`)? */
export const isReviewCodeVerdict = (body: string): boolean => namespaceRe("code").test(body);

export interface JudgeInput {
	readonly threads: ReadonlyArray<ReviewThread>;
	/** The latest AUTHORIZED (write+ collaborator) review-code verdict body, or null if none. */
	readonly verdictBody: string | null;
}

export interface Verdict {
	readonly pass: boolean;
	readonly unaccounted: ReadonlyArray<ReviewThread>;
	readonly report: string;
}

/**
 * The gate decision: red when any live-unresolved thread is unaccounted-for in the latest
 * review-code verdict. Zero threads, or every live thread accounted, passes — zero threads
 * is a real, common, valid state (nothing to gate), NOT a broken scan, so it is a clean
 * pass rather than a fail-closed zero-scope red; the fail-closed-on-unreadable case lives in
 * the IO shell, which reds when it cannot READ the thread state at all (ADR 0092's
 * zero-scope stance applied at the right seam — an unreadable channel, not an empty one).
 */
export const judge = (input: JudgeInput): Verdict => {
	const live = liveUnresolved(input.threads);
	const unaccounted = live.filter((thread) => !isAccounted(thread, input.verdictBody));
	const pass = unaccounted.length === 0;
	return {pass, unaccounted, report: renderReport(input, live, unaccounted)};
};

const describeThread = (thread: ReviewThread): string => {
	const who = thread.author ? `@${thread.author}` : "(unknown author)";
	const outdated = thread.isOutdated ? " [outdated]" : "";
	const excerpt = thread.excerpt.trim().replace(/\s+/g, " ");
	return `${siteToken(thread)} ${who}${outdated}: "${excerpt}"`;
};

const renderReport = (
	input: JudgeInput,
	live: ReadonlyArray<ReviewThread>,
	unaccounted: ReadonlyArray<ReviewThread>,
): string => {
	if (unaccounted.length === 0) {
		const scanned = input.threads.length;
		if (scanned === 0) return "unresolved-threads-guard: no review threads on this PR — clean.";
		return `unresolved-threads-guard: scanned ${scanned} review thread(s), ${live.length} unresolved, all accounted-for in the review-code verdict — clean.`;
	}
	const rows = unaccounted.map((thread) => `  - ${describeThread(thread)}`).join("\n");
	const verdictState =
		input.verdictBody === null
			? "there is no authorized review-code verdict naming it yet"
			: "the latest review-code verdict does not name its path:line";
	return [
		`unresolved-threads-guard: ${unaccounted.length} substantive unresolved inline review thread(s) are unaccounted-for — ${verdictState}.`,
		rows,
		"",
		"Per ADR 0158, discharge each by EITHER resolving the thread with a written rationale (a genuine nit),",
		"OR surfacing it in the review-code verdict as a `[FAIL] unresolved-threads — path:line ...` row (a real",
		"objection, which routes back to write-code). A review-code PASS cannot silently omit an unresolved thread.",
	].join("\n");
};
