/**
 * Whether a PR comment is an owner's hand-check the ui gate may stand on in place of a render.
 *
 * Four facts, all read off the comment, and all required: it is on this PR, a control-plane account
 * wrote it, it names the PR's exact head, and it carries a screenshot. The head is what keeps the
 * evidence honest — a hand-check of an earlier tree says nothing about this one, and the record the
 * route posts is bound to this head alone.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10038#issuecomment-5860347862
 */

import type {CommentRecord} from "../io/issues.ts";
import {headSha, SHA_MIN} from "../wire/marker-line.ts";

/** A comment id, or a comment URL ending in `#issuecomment-<id>`. */
export const handCheckCommentId = (raw: string): number | null => {
	const trimmed = raw.trim();
	const matched = /^(?:\S*#issuecomment-)?(\d+)$/.exec(trimmed);
	const id = matched === null ? Number.NaN : Number(matched[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** A markdown image, an HTML `<img>`, or an attachment link GitHub renders as one. */
const SCREENSHOT = /!\[[^\]]*\]\([^)\s]+[^)]*\)|<img\s[^>]*src=|\/user-attachments\/assets\//i;

const HEX_TOKEN = new RegExp(`\\b[0-9a-f]{${SHA_MIN},40}\\b`, "gi");

/** Whether `body` names `head` — any 7–40 hex token that is a prefix of it. */
const namesHead = (body: string, head: string): boolean =>
	[...body.matchAll(HEX_TOKEN)].some((match) => {
		const token = headSha(match[0]);
		return token !== null && head.toLowerCase().startsWith(token);
	});

export type HandCheck =
	| {readonly _tag: "Admitted"; readonly comment: CommentRecord}
	| {readonly _tag: "Inadmissible"; readonly reason: string};

export const admitHandCheck = (
	id: number,
	comments: ReadonlyArray<CommentRecord>,
	head: string,
	owners: ReadonlySet<string>,
): HandCheck => {
	const comment = comments.find((candidate) => candidate.id === id);
	if (comment === undefined) {
		return {_tag: "Inadmissible", reason: `comment ${id} is not on this PR`};
	}
	if (!owners.has(comment.author)) {
		return {
			_tag: "Inadmissible",
			reason: `comment ${id} is by ${comment.author}, who is not on the control plane — only an owner's hand-check stands in for a render`,
		};
	}
	if (!namesHead(comment.body, head)) {
		return {
			_tag: "Inadmissible",
			reason: `comment ${id} does not name the head ${head} — a hand-check of another tree says nothing about this one`,
		};
	}
	if (!SCREENSHOT.test(comment.body)) {
		return {
			_tag: "Inadmissible",
			reason: `comment ${id} carries no screenshot — a hand-check is the screenshots that stand in for the render`,
		};
	}
	return {_tag: "Admitted", comment};
};
