/**
 * A `review-ui` verdict with its evidence gallery, and the GitHub replies that make that evidence
 * open or not — for the readers that re-check it before they count the verdict.
 */
import {createHash} from "node:crypto";
import type {HttpReply, Scripted} from "../fakes.test-support.ts";
import {emit as emitGallery} from "./evidence-gallery.ts";

const UUID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
export const EVIDENCE_URL = `https://github.com/user-attachments/assets/${UUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/1783869/657136403-${UUID}.png?jwt=a.b.c&X-Amz-Expires=300`;
/** The judged capture's bytes, as a string body the fake transport serves verbatim. */
const JUDGED = "png bytes";

const FETCH = /^GET https:\/\/private-user-images\.githubusercontent\.com\//;

/** `firstLine` as a posted verdict: its marker line, then a gallery holding one judged capture. */
export const evidenced = (firstLine: string): string =>
	`${firstLine}\n\n${emitGallery([
		{
			title: "/pano @ desktop",
			url: EVIDENCE_URL,
			sha256: createHash("sha256").update(JUDGED).digest("hex"),
		},
	])}\n`;

const rendered = (repo: string, commentId: number): Scripted => [
	new RegExp(`^GET https://api\\.github\\.com/repos/${repo}/issues/comments/${commentId}$`),
	{
		status: 200,
		body: JSON.stringify({
			body_html: `<p><img src="${SIGNED.replaceAll("&", "&amp;")}" alt="/pano @ desktop"></p>`,
		}),
	},
];

/** The comment renders, and its capture serves the judged bytes. */
export const evidenceOpens = (repo: string, commentId: number): ReadonlyArray<Scripted> => [
	rendered(repo, commentId),
	[FETCH, {status: 200, body: JUDGED}],
];

/** The comment renders, and its capture answers `status` — or other bytes on a `200`. */
export const evidenceDoesNotOpen = (
	repo: string,
	commentId: number,
	reply: HttpReply = {status: 404, body: ""},
): ReadonlyArray<Scripted> => [rendered(repo, commentId), [FETCH, reply]];

/** The comment's rendered read itself fails — the evidence is UNKNOWN, not broken. */
export const evidenceUnreadable = (repo: string, commentId: number): ReadonlyArray<Scripted> => [
	[
		new RegExp(`^GET https://api\\.github\\.com/repos/${repo}/issues/comments/${commentId}$`),
		{status: 404, body: "{}"},
	],
];
