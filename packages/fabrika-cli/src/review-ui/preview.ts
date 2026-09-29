/**
 * Which preview a PR announces, resolved off its comment list.
 *
 * The parsing is the capture machinery's one resolver module (`../capture/resolve.ts`); what lives
 * here is the *choice* — which comment, which app, and how the four outcomes route. They are four
 * and not two on purpose: an absent announcement is a proven fact about the repo (the CANT-SEE
 * route), while an unreadable one and an ambiguous one are UNKNOWNs a reviewer must not read as
 * "no preview".
 *
 * A no-preview marker (`<!-- preview-deploy:none head:<sha> -->`) proves absence only at the head
 * it names. A marker naming another head means the workflow has not answered for this push yet, so
 * it is unreadable rather than absent.
 *
 * The comment is picked by **recency, explicitly** — the newest announcement wins, and a repo that
 * posts a fresh comment per deploy is as readable as one that upserts a sticky one. Leaving the
 * pick to whatever order the API returned is how a stale announcement comes to bind a new head.
 */
import {
	announcedApps,
	isPreviewAnnouncement,
	noPreviewHead,
	type PreviewAnnouncement,
	readPreviewAnnouncement,
} from "../capture/resolve.ts";
import type {CommentRecord} from "../io/issues.ts";

export type PreviewResolution =
	/**
	 * `apps` is every app the announcement carries a block for, not only the chosen one: a caller
	 * that shoots a surface has to know which apps this preview deployed at all, because a surface
	 * belonging to an app nobody deployed would otherwise be shot at the chosen app's origin and come
	 * back as its not-found page.
	 */
	| {
			readonly _tag: "Resolved";
			readonly value: PreviewAnnouncement;
			readonly apps: readonly string[];
	  }
	/**
	 * Proven: no comment carries the preview anchor at all (`markedAt: null`), or the newest one is a
	 * no-preview marker naming the judged head (`markedAt` is the SHA it names).
	 */
	| {readonly _tag: "NoPreview"; readonly markedAt: string | null}
	/** The announcement names several apps and the caller picked none. */
	| {readonly _tag: "Ambiguous"; readonly apps: readonly string[]}
	/** The anchor is there and unreadable for this app — unreadable is not absent. */
	| {readonly _tag: "Malformed"; readonly reason: string};

/** The write stamp when the platform gave one, else the filing time — never an arbitrary order. */
const writtenAt = (comment: CommentRecord): string =>
	comment.updatedAt === "" ? comment.createdAt : comment.updatedAt;

const newestAnnouncement = (comments: readonly CommentRecord[]): CommentRecord | undefined =>
	comments
		.filter((comment) => isPreviewAnnouncement(comment.body))
		.reduce<CommentRecord | undefined>((newest, comment) => {
			if (newest === undefined) return comment;
			const [a, b] = [writtenAt(comment), writtenAt(newest)];
			if (a !== b) return a > b ? comment : newest;
			return comment.id > newest.id ? comment : newest;
		}, undefined);

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const sameHead = (a: string, b: string): boolean => {
	const [x, y] = [a.toLowerCase(), b.toLowerCase()];
	return x.startsWith(y) || y.startsWith(x);
};

/** `head` is the SHA the caller judges; a no-preview marker proves absence at that head alone. */
export const resolvePreview = (
	comments: readonly CommentRecord[],
	app: string | null,
	head: string,
): PreviewResolution => {
	const announcement = newestAnnouncement(comments);
	if (announcement === undefined) return {_tag: "NoPreview", markedAt: null};
	const apps = announcedApps(announcement.body);
	const marked = noPreviewHead(announcement.body);
	if (marked !== null) {
		if (apps.length > 0) {
			return {
				_tag: "Malformed",
				reason: `the comment carries both a no-preview marker and app blocks (${apps.join(", ")})`,
			};
		}
		if (sameHead(marked, head)) return {_tag: "NoPreview", markedAt: marked};
		return {
			_tag: "Malformed",
			reason: `the no-preview marker names ${marked}, not the head ${head} — no preview at an earlier push is not proof of none at this one`,
		};
	}
	if (apps.length === 0) {
		return {
			_tag: "Malformed",
			reason: "the comment carries the preview anchor but names no app block",
		};
	}
	if (app === null && apps.length > 1) return {_tag: "Ambiguous", apps};
	const chosen = app ?? (apps[0] as string);
	const read = readPreviewAnnouncement(announcement.body, chosen);
	if (read._tag === "Announced") return {_tag: "Resolved", value: read.value, apps};
	if (read._tag === "Malformed") return {_tag: "Malformed", reason: read.reason};
	return {
		_tag: "Malformed",
		reason: `the announcement names apps ${apps.join(", ")}, not "${chosen}"`,
	};
};
