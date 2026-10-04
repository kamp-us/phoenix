/**
 * Whether a posted `review-ui` verdict's evidence still opens — the question `ship gate` and
 * `lane prove` ask before they count that verdict.
 *
 * `review-ui post` checks its evidence before and after it posts, but a posted verdict is never
 * withdrawn: when the after-post check fails the verb exits `9` and the comment stays. So a reader
 * that counts the verdict has to ask again. The read is `review-ui post`'s own after-post read-back —
 * the comment's rendered HTML, each embedded capture's signed link fetched anonymously — held to the
 * digests the gallery recorded instead of to local bytes a gate does not have.
 *
 * Three answers, because the gate owes them three different outcomes: a verdict whose evidence opens
 * counts, one whose evidence does not open does not count, and a read that never reached GitHub
 * leaves the answer UNKNOWN rather than calling the evidence broken.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9725#issuecomment-5800916149
 */
import {Effect} from "effect";
import {readBack, renderedHtml} from "../io/attachment-read-back.ts";
import {ambientToken, onTransport} from "../io/gh-api.ts";
import type {Shell} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import {read as readGallery} from "./evidence-gallery.ts";
import {renderedCommentCall} from "./upload-leg.ts";

export type EvidenceStanding =
	| {readonly _tag: "Opens"}
	| {readonly _tag: "DoesNotOpen"; readonly reasons: readonly [string, ...string[]]}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** The comment a verdict was read from: its id for the rendered read, its body for the gallery. */
export interface VerdictComment {
	readonly id: number;
	readonly body: string;
}

export const standingEvidence = (repo: string, comment: VerdictComment): Shell<EvidenceStanding> =>
	Effect.gen(function* () {
		const gallery = readGallery(comment.body);
		if (gallery._tag === "Unprovable") {
			return {_tag: "DoesNotOpen", reasons: [gallery.reason]} as const;
		}
		const token = yield* ambientToken;
		if (token._tag === "Failure") return {_tag: "Unreadable", reason: token.reason} as const;
		return yield* onTransport(
			Effect.gen(function* () {
				const rendered = yield* renderedHtml(
					token.value,
					renderedCommentCall(repo, comment.id),
					(r) =>
						isRecord(r.body) && typeof r.body.body_html === "string" ? r.body.body_html : null,
				);
				if ("reason" in rendered) {
					return {_tag: "Unreadable", reason: rendered.reason} as const;
				}
				const reasons: string[] = [];
				for (const evidence of gallery.evidence) {
					const failure = yield* readBack(rendered.html, evidence);
					if (failure !== null) reasons.push(`${evidence.url}: ${failure}`);
				}
				const [first, ...rest] = reasons;
				return first === undefined
					? ({_tag: "Opens"} as const)
					: ({_tag: "DoesNotOpen", reasons: [first, ...rest]} as const);
			}),
		);
	});
