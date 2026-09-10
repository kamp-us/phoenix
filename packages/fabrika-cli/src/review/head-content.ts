/**
 * The head digest a content-bound verdict is judged against — resolved lazily, from one derivation
 * every PR-scoped staleness reader shares.
 *
 * It exists because two readers answered "is this verdict still current?" out of two copies of the
 * same rule: `ship gate` read the content field and `build verdicts` read the head SHA, so a rebase
 * carrying no content change read *current* to the merge gate and *stale* to the repair loop, and
 * the lane spent a repair round nothing had found a defect in.
 * A caller here supplies the claims and takes the digest; the comparison itself stays
 * {@link bindToContent}'s, so the two readers cannot hold different rules to disagree from.
 *
 * **The read is conditional, and {@link needsHeadDigest} is the condition rather than a second head
 * test.** A claim needs a digest exactly when `bindToContent` would answer `Unbindable` for want of
 * one, which is asked by calling that function with no digest — so the trigger is a fold of the same
 * derivation, and the common path (every claim at this head) never touches git.
 *
 * **A digest that could not be read leaves `null`, and `null` blocks.** `bindToContent` reads it as
 * `Unbindable`, every consumer treats that as not-current, and that is the same answer these
 * readers gave before the content field existed — which is what makes the git read non-regressive
 * rather than a new way to wedge a lane.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {PullRecord} from "../io/pulls.ts";
import {bindToContent} from "../wire/verdict-marker.ts";
import {contentDigestAt} from "./content-binding.ts";
import {bindHead} from "./head.ts";

/** The two bound fields of a verdict claim — a {@link import("../wire/verdict-marker.ts").VerdictMarker} satisfies it. */
export interface ContentClaim {
	readonly sha: string;
	readonly content: string | null;
}

/** The resolved digest, plus what a caller must print when it could not be read. */
export interface HeadContent {
	readonly digest: string | null;
	readonly diagnostics: ReadonlyArray<string>;
}

/** Whether judging this claim at `head` needs the head's own digest. */
export const needsHeadDigest = (claim: ContentClaim, head: string): boolean =>
	claim.content !== null && bindToContent(claim, head, null)._tag === "Unbindable";

/**
 * This head's content digest, read only when some claim's binding turns on it.
 *
 * `asked` is the caller's `--sha` where it has one and `null` where the live head is the subject;
 * either way the digest is taken over `mergeBase...head`, the same range `review post` writes its
 * markers from.
 */
export const headContentFor = (
	verb: string,
	repo: string,
	pr: number,
	pull: PullRecord,
	asked: string | null,
	claims: ReadonlyArray<ContentClaim>,
	head: string,
): Effect.Effect<HeadContent, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!claims.some((claim) => needsHeadDigest(claim, head))) {
			return {digest: null, diagnostics: []};
		}
		const bound = yield* bindHead(verb, repo, pr, pull, asked);
		const digest =
			bound._tag === "Bound" ? yield* contentDigestAt(bound.head.mergeBase, bound.head.sha) : null;
		return digest !== null && digest._tag === "Ok"
			? {digest: digest.value, diagnostics: []}
			: {
					digest: null,
					diagnostics: [
						`${verb}: a verdict at another head binds content, but this head's digest could not be read — every such verdict resolves stale.`,
					],
				};
	});
