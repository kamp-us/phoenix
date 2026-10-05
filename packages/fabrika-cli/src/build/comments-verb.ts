/**
 * `build comments` — one issue's comment thread, oldest first, each body through the content gate.
 *
 * A thin surface over `listComments`: it adds no GitHub comment read of its own. It serves a closed
 * issue on purpose, because a ruling is often cited from an issue its own transcription closed.
 * Every comment is printed whoever wrote it, with its author beside it; a reading posture lands in
 * the content gate for every verb at once, not here.
 * @ruling https://github.com/kamp-us/phoenix/issues/7814
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, getIssue, listComments} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {contentOf, gate} from "./content-gate.ts";
import {resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "build comments";

export interface CommentsOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** One comment as this verb serves it: the stored record, its citation link, and its gated body. */
export interface ServedComment {
	readonly id: number;
	readonly author: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** The `.../issues/<n>#issuecomment-<id>` form `--cites` takes, so a lane can cite it verbatim. */
	readonly url: string;
	readonly body: string;
}

export const commentUrl = (repo: string, issue: number, id: number): string =>
	`https://github.com/${repo}/issues/${issue}#issuecomment-${id}`;

const serve = (repo: string, issue: number, comment: CommentRecord): ServedComment => ({
	id: comment.id,
	author: comment.author,
	createdAt: comment.createdAt,
	updatedAt: comment.updatedAt,
	url: commentUrl(repo, issue, comment.id),
	body: contentOf(gate("comment-body", `comment ${comment.id}`, comment.body)),
});

export const runComments = (
	options: CommentsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {number} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {repo} = resolved;

		const target = yield* getIssue(repo, number);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${number} is proven absent.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${number}: ${target.reason} — its comment thread is UNKNOWN.`,
			);
		}

		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments on #${number}: ${listed.reason} — its comment thread is UNKNOWN.`,
			);
		}

		const comments = listed.value.map((comment) => serve(repo, number, comment));
		return answer(JSON.stringify({number, state: target.value.state, comments}), [
			scannedLine(
				VERB,
				comments.length,
				"comment",
				`#${number} in ${repo} is ${target.value.state}`,
			),
		]);
	});
