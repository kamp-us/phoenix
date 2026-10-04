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

/** Which of the four facts a comment failed first, in the order they are checked. */
export type FailedFact = "absent" | "author" | "head" | "screenshot";

export type HandCheck =
	| {readonly _tag: "Admitted"; readonly comment: CommentRecord}
	| {readonly _tag: "Inadmissible"; readonly fact: FailedFact; readonly reason: string};

export const admitHandCheck = (
	id: number,
	comments: ReadonlyArray<CommentRecord>,
	head: string,
	owners: ReadonlySet<string>,
): HandCheck => {
	const comment = comments.find((candidate) => candidate.id === id);
	if (comment === undefined) {
		return {_tag: "Inadmissible", fact: "absent", reason: `comment ${id} is not on this PR`};
	}
	if (!owners.has(comment.author)) {
		return {
			_tag: "Inadmissible",
			fact: "author",
			reason: `comment ${id} is by ${comment.author}, who is not on the control plane — only an owner's hand-check stands in for a render`,
		};
	}
	if (!namesHead(comment.body, head)) {
		return {
			_tag: "Inadmissible",
			fact: "head",
			reason: `comment ${id} does not name the head ${head} — a hand-check of another tree says nothing about this one`,
		};
	}
	if (!SCREENSHOT.test(comment.body)) {
		return {
			_tag: "Inadmissible",
			fact: "screenshot",
			reason: `comment ${id} carries no screenshot — a hand-check is the screenshots that stand in for the render`,
		};
	}
	return {_tag: "Admitted", comment};
};

/**
 * The newest admissible hand-check on the PR, or `null` where no comment passes all four facts —
 * so a reviewer never browses comments for one; the verb reads them and names what it stood on.
 */
export const findHandCheck = (
	comments: ReadonlyArray<CommentRecord>,
	head: string,
	owners: ReadonlySet<string>,
): CommentRecord | null => {
	const admitted = comments.filter(
		(comment) => admitHandCheck(comment.id, comments, head, owners)._tag === "Admitted",
	);
	const stamp = (comment: CommentRecord) =>
		comment.updatedAt === "" ? comment.createdAt : comment.updatedAt;
	return admitted.reduce<CommentRecord | null>((newest, comment) => {
		if (newest === null) return comment;
		const [a, b] = [stamp(comment), stamp(newest)];
		if (a !== b) return a > b ? comment : newest;
		return comment.id > newest.id ? comment : newest;
	}, null);
};

/** The one fact a comment naming the head failed. */
export type NearMissFact = "author" | "screenshot";

export interface NearMiss {
	readonly comment: CommentRecord;
	readonly fact: NearMissFact;
}

/**
 * The comments that name `head` and fail exactly one other fact, in the order given — somebody's
 * attempt at a hand-check, as opposed to a comment that merely mentions the commit. A comment
 * failing both is left out: every agent note that cites the head would otherwise be listed as a
 * failed attempt.
 */
export const nearMisses = (
	comments: ReadonlyArray<CommentRecord>,
	head: string,
	owners: ReadonlySet<string>,
): ReadonlyArray<NearMiss> =>
	comments.flatMap((comment): ReadonlyArray<NearMiss> => {
		if (!namesHead(comment.body, head)) return [];
		const owner = owners.has(comment.author);
		if (owner === SCREENSHOT.test(comment.body)) return [];
		return [{comment, fact: owner ? "screenshot" : "author"}];
	});
