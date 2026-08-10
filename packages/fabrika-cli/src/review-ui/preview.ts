/**
 * Which preview a PR announces, resolved off its comment list.
 *
 * The parsing is the capture machinery's one resolver module (`../capture/resolve.ts`); what lives
 * here is the *choice* — which comment, which app, and how the four outcomes route. They are four
 * and not two on purpose: an absent announcement is a proven fact about the repo (the CANT-SEE
 * route), while an unreadable one and an ambiguous one are UNKNOWNs a reviewer must not read as
 * "no preview".
 *
 * The comment is picked by **recency, explicitly** — the newest announcement wins, and a repo that
 * posts a fresh comment per deploy is as readable as one that upserts a sticky one. Leaving the
 * pick to whatever order the API returned is how a stale announcement comes to bind a new head.
 */
import {
	announcedApps,
	isPreviewAnnouncement,
	type PreviewAnnouncement,
	readPreviewAnnouncement,
} from "../capture/resolve.ts";
import type {CommentRecord} from "../io/issues.ts";

export type PreviewResolution =
	| {readonly _tag: "Resolved"; readonly value: PreviewAnnouncement}
	/** Proven: no comment carries the preview anchor at all. */
	| {readonly _tag: "NoPreview"}
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

export const resolvePreview = (
	comments: readonly CommentRecord[],
	app: string | null,
): PreviewResolution => {
	const announcement = newestAnnouncement(comments);
	if (announcement === undefined) return {_tag: "NoPreview"};
	const apps = announcedApps(announcement.body);
	if (apps.length === 0) {
		return {
			_tag: "Malformed",
			reason: "the comment carries the preview anchor but names no app block",
		};
	}
	if (app === null && apps.length > 1) return {_tag: "Ambiguous", apps};
	const chosen = app ?? (apps[0] as string);
	const read = readPreviewAnnouncement(announcement.body, chosen);
	if (read._tag === "Announced") return {_tag: "Resolved", value: read.value};
	if (read._tag === "Malformed") return {_tag: "Malformed", reason: read.reason};
	return {
		_tag: "Malformed",
		reason: `the announcement names apps ${apps.join(", ")}, not "${chosen}"`,
	};
};
