/**
 * The standing `review-code` verdict a `routed-elsewhere` record rests on.
 *
 * The interim exception that lets a hand-verification stand in for a render prescribes a clause
 * asserting a text review PASS beside it, and `review-ui route` asserted that conjunction while
 * reading neither half. The ruling below settles it: the text PASS is a precondition of the route,
 * not commentary on it, so the verb reads it here.
 *
 * **The reader is `review verdicts`'s, never a second one.** A claim is the `verdict-marker` first
 * line or the §CP advisory carrier, exactly the two carriers that sweep resolves; the in-force
 * ordering is `ship gate`'s own {@link inForce}, and currency is {@link bindToContent}'s. Three
 * copies of one rule is how a marker reads current to one gate and stale to the next — the failure
 * the hand-verification's own currency check was mechanized to stop.
 *
 * What is **not** read here is the host's native review fold. `ship gate` folds an `APPROVED` or
 * `CHANGES_REQUESTED` review into `review-code` because it is the merge authority; this verb only
 * judges whether the record's own clause states something true, and the fold costs a second API
 * surface for a carrier the pipeline's text gate does not emit. A route's refusal line names
 * `review verdicts`, so a lane whose text verdict lives only in a native review sees which reader
 * answered.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9196#issuecomment-5688739893
 */
import type {CommentRecord} from "../io/issues.ts";
import {readAdvisory} from "../review/advisory.ts";
import {inForce} from "../ship/gate-verb.ts";
import {bindToContent, read as readMarker} from "../wire/verdict-marker.ts";

/** The namespace whose verdict the route rests on — the text gate's, fixed. */
export const TEXT_NAMESPACE = "review-code";

/** One comment's claim about {@link TEXT_NAMESPACE}, before ordering or currency is applied. */
export interface TextClaim {
	readonly namespace: string;
	readonly polarity: "PASS" | "FAIL";
	readonly sha: string;
	/** The content the claim binds, or `null` for a carrier that emits none. */
	readonly content: string | null;
	readonly carrier: "marker" | "advisory";
	readonly stamp: string;
	readonly commentId: number;
}

/**
 * Every `review-code` claim the comments carry.
 *
 * A verdict retired below `review/supersede.ts`'s fence is not a claim: the surviving verdict holds
 * the comment's first line, which is the only line either carrier is read from.
 */
export const textClaims = (comments: ReadonlyArray<CommentRecord>): ReadonlyArray<TextClaim> => {
	const claims: TextClaim[] = [];
	for (const comment of comments) {
		const marker = readMarker(comment.body);
		if (marker._tag === "Found") {
			if (marker.value.namespace !== TEXT_NAMESPACE) continue;
			claims.push({
				namespace: marker.value.namespace,
				polarity: marker.value.polarity,
				sha: marker.value.sha,
				content: marker.value.content,
				carrier: "marker",
				stamp: comment.updatedAt === "" ? comment.createdAt : comment.updatedAt,
				commentId: comment.id,
			});
			continue;
		}
		const advisory = readAdvisory(comment.body);
		if (advisory === null || advisory.namespace !== TEXT_NAMESPACE) continue;
		claims.push({
			namespace: advisory.namespace,
			// The advisory carrier is PASS-only; `review post` refuses a FAIL through it on `10`.
			polarity: "PASS",
			sha: advisory.sha,
			// It withholds a content binding by design, so it stays head-bound.
			content: null,
			carrier: "advisory",
			stamp: comment.updatedAt === "" ? comment.createdAt : comment.updatedAt,
			commentId: comment.id,
		});
	}
	return claims;
};

/**
 * The text verdict in force at `head`, or `null` where none binds it.
 *
 * `null` folds two facts a route treats alike — no claim at all, and a claim the head moved past —
 * because both leave the record's clause with no PASS to assert. The caller's stderr names which.
 */
export const standingTextVerdict = (
	claims: ReadonlyArray<TextClaim>,
	head: string,
	digest: string | null,
): TextClaim | null => {
	const winner = inForce(claims, head);
	if (winner === null) return null;
	return bindToContent(winner, head, digest)._tag === "Current" ? winner : null;
};
