import type {CommentRecord} from "../io/issues.ts";
import {emit, markedIssue, rulingUrl, scopeDigest} from "../wire/decision-ruling.ts";
import {markerTime} from "../wire/grill-marker.ts";

/** A conforming `decision-ruled` marker comment on `issue`, ruled at `at`, posted by `author`. */
export const rulingComment = (
	repo: string,
	issue: number,
	at: string,
	author: string,
	id = issue * 100,
): CommentRecord => {
	const marked = markedIssue(issue);
	const digest = scopeDigest("0123456789ab");
	const ruling = rulingUrl(`https://github.com/${repo}/issues/${issue}#issuecomment-${id - 1}`);
	const stamp = markerTime(at);
	if (marked === null || digest === null || ruling === null || stamp === null) {
		throw new Error("the fixture does not brand");
	}
	return {
		id,
		author,
		createdAt: at,
		updatedAt: at,
		body: emit({issue: marked, digest, ruling, supersedes: null, at: stamp}),
	};
};
