/**
 * The pure core of `leak-guard scan-pr` — fan the shared `findCommentLeaks` detector over a PR's
 * already-fetched comments (the issue conversation + the inline review comments) and report every
 * live leak with the comment id + surface that carries it.
 *
 * This is the LANDED-comment re-check that no emit-side guard can provide: every existing leak guard
 * (`emissionDefect`, `verdict post`'s read-back, the review-* MANDATE blocks) is a step the reviewer
 * *chooses* to run, so a freelance raw `gh api -f body=@$FILE` verdict post bypasses all of them and
 * leaks a machine-local path onto a public PR regardless of emit path (#3018/#3005). Re-scanning the
 * comments straight off the REST boundary moves that one missing check off the reviewer's transcript
 * to the ship-it preflight every merge crosses (issue #3019).
 */
import {findCommentLeaks, type Leak} from "./leak-guard.ts";

/** Which surface a comment landed on — the PR's issue conversation, or an inline review comment. */
export type PrCommentKind = "issue" | "review";

/** A landed PR comment reduced to the fields the scan needs. */
export interface PrComment {
	readonly id: number;
	readonly kind: PrCommentKind;
	readonly body: string;
}

/** One machine-local path leak found in a landed comment — the comment id + surface + the leak. */
export interface CommentLeak {
	readonly id: number;
	readonly kind: PrCommentKind;
	readonly leak: Leak;
}

/** Every leak across all comments (report order = input order, then per-comment leak order). */
export const scanPrComments = (comments: ReadonlyArray<PrComment>): ReadonlyArray<CommentLeak> =>
	comments.flatMap((c) => findCommentLeaks(c.body).map((leak) => ({id: c.id, kind: c.kind, leak})));
