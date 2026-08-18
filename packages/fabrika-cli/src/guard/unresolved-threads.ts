/**
 * The IO-free core of `guard unresolved-threads check` — the accounting question `ship threads`
 * hands off: is every live-unresolved review thread NAMED in the latest authorized `review-code:`
 * verdict?
 *
 * The rule ADR 0158 states as reviewer prose, given teeth. A `review-code` agent could post
 * `PASS … merge-ready` and omit the unresolved-thread accounting entirely, and on a §CP PR — which
 * banks for a manual merge and never reaches the enqueue refusal — that prose was the only thing
 * standing between an unaddressed finding and a human clicking merge. #3329 is what that costs: a
 * CodeQL inline finding reached a merger under a merge-ready flag (#3331).
 *
 * So: a live-unresolved inline thread, human or bot, is unaccounted-for unless the verdict body
 * names its `path:line`. The check is **polarity-blind** — a `[FAIL] unresolved-threads — path:line`
 * row accounts for the thread exactly as a PASS row does, because the FAIL blocks the merge on its
 * own and the thing being gated here is the silent omission, not the reviewer's call. It re-decides
 * nothing about substantive-vs-nit: a genuine nit is discharged ADR 0158's way, by resolving the
 * thread with a written rationale, which takes it out of the live set.
 *
 * **Zero threads is a clean pass, not zero scope.** A PR with no review threads is the common,
 * valid state — there is nothing to account for. The fail-closed case ADR 0092 asks for is an
 * UNREADABLE thread channel, and that lives in `./unresolved-threads-verb.ts` where the read
 * happens.
 */

import type {ReviewThread} from "../ship/github.ts";
import {excerptOf, openingAuthorOf} from "../ship/threads.ts";
import {type Annotation, atFile, atLine, unlocated} from "./annotate.ts";
import {annotationsOrNone, clean, type GuardVerdict, violation} from "./verdict.ts";

const VERB = "guard unresolved-threads check";

/**
 * What a path-less pr-level thread degrades to.
 *
 * Deliberately a phrase no verdict writes by accident: the accounting test is a substring match, so
 * a short token like `pr-level` could be satisfied by unrelated prose, and a thread that nobody can
 * cite by site must fail closed as unaccounted rather than pass on a coincidence.
 */
const PR_LEVEL = "(pr-level review thread)";

/**
 * The accounting key: the exact `path:line` ADR 0158's row format asks a reviewer to write.
 *
 * Not `ship threads`' `siteOf` — that one renders a site for a human to read, and renders a missing
 * line as `?`. This one is compared against what a reviewer typed, so it degrades the other way: a
 * line-less thread keys on the bare path (which a verdict can name), and a path-less one on
 * {@link PR_LEVEL} (which it cannot).
 */
export const siteToken = (thread: ReviewThread): string => {
	if (thread.path === null) return PR_LEVEL;
	return thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
};

/**
 * The threads still open — `isResolved` false, and nothing else.
 *
 * That is the whole predicate on purpose. An outdated-but-unresolved thread is still an unaddressed
 * objection until its author resolves it, so an `isOutdated` exemption would be a silent fail-open;
 * fabrika's sanctioned read does not even surface the field, which makes the exemption
 * unrepresentable rather than merely forbidden.
 */
export const liveUnresolved = (threads: ReadonlyArray<ReviewThread>): ReadonlyArray<ReviewThread> =>
	threads.filter((thread) => !thread.isResolved);

/**
 * Whether the verdict body names this thread's site.
 *
 * A `null` body — no authorized `review-code` verdict on the PR yet — accounts for nothing. A PR
 * carrying an unresolved thread and no verdict naming it is not merge-ready, so the absence of a
 * verdict is a red rather than a pass.
 */
export const isAccounted = (thread: ReviewThread, verdictBody: string | null): boolean =>
	verdictBody === null ? false : verdictBody.includes(siteToken(thread));

export interface JudgeInput {
	readonly threads: ReadonlyArray<ReviewThread>;
	/** The latest AUTHORIZED (write+ collaborator) `review-code` verdict body, or `null` if none. */
	readonly verdictBody: string | null;
}

/** Every live thread the verdict does not name. Exported so the report and a test read one list. */
export const unaccountedIn = (input: JudgeInput): ReadonlyArray<ReviewThread> =>
	liveUnresolved(input.threads).filter((thread) => !isAccounted(thread, input.verdictBody));

const describeThread = (thread: ReviewThread): string => {
	const who = openingAuthorOf(thread);
	return `${siteToken(thread)} ${who === "" ? "(unknown author)" : `@${who}`}: "${excerptOf(thread)}"`;
};

const REMEDIATION = [
	"Per ADR 0158, discharge each by EITHER resolving the thread with a written rationale (a genuine nit),",
	"OR surfacing it in the review-code verdict as a `[FAIL] unresolved-threads — path:line ...` row (a real",
	"objection, which routes back to write-code). A review-code PASS cannot silently omit an unresolved thread.",
];

const violationReport = (
	verdictBody: string | null,
	unaccounted: ReadonlyArray<ReviewThread>,
): string =>
	[
		`${VERB}: ${unaccounted.length} unresolved inline review thread(s) are unaccounted-for — ${
			verdictBody === null
				? "there is no authorized review-code verdict naming them yet"
				: "the latest review-code verdict does not name their path:line"
		}.`,
		...unaccounted.map((thread) => `  - ${describeThread(thread)}`),
		"",
		...REMEDIATION,
	].join("\n");

const annotationFor = (thread: ReviewThread): Annotation => {
	const message = `${VERB}: this review thread is unresolved and the latest review-code verdict does not name ${siteToken(thread)}. Resolve it with a written rationale, or surface it as a \`[FAIL] unresolved-threads — ${siteToken(thread)}\` row (ADR 0158).`;
	if (thread.path === null) return unlocated("error", message);
	return thread.line === null
		? atFile("error", thread.path, message)
		: atLine("error", thread.path, thread.line, message);
};

const cleanSummary = (scanned: number, live: number): string =>
	scanned === 0
		? `${VERB}: no review threads on this PR — nothing to account for`
		: `${VERB}: scanned ${scanned} review thread(s), ${live} unresolved, all accounted-for in the review-code verdict`;

/**
 * The gate: red when any live-unresolved thread is unaccounted-for.
 *
 * `Clean` carries the scanned thread count, which may be zero — see the module docblock for why
 * that is a pass here and an UNKNOWN at the read seam instead.
 */
export const judge = (input: JudgeInput): GuardVerdict => {
	const unaccounted = unaccountedIn(input);
	if (unaccounted.length === 0) {
		return clean(
			cleanSummary(input.threads.length, liveUnresolved(input.threads).length),
			input.threads.length,
		);
	}
	return violation(
		violationReport(input.verdictBody, unaccounted),
		annotationsOrNone(() => unaccounted.map(annotationFor)),
	);
};
