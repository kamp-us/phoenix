/**
 * The evidence gallery a `review-ui` verdict carries: one hosted image per judged shot, each with
 * the sha256 of the bytes that were judged.
 *
 * `review-ui post` writes it and `ship gate` / `lane prove` read it back, so the digest is what lets
 * a gate hold a hosted capture to the judged bytes without the reviewer's local set. The digest
 * rides an HTML comment, so it renders as nothing and leaves the image markdown GitHub rewrites
 * untouched.
 *
 * Only the verdict in force is read: a re-post keeps prior verdicts, and their galleries, below
 * `../review/supersede.ts`'s fence, and none of those is the evidence the first line stands on.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9725#issuecomment-5800916149
 */
import {split} from "../review/supersede.ts";

export const HEADING = "## Evidence";

/** One judged shot as the gallery records it. */
export interface Shot {
	/** The heading and alt text — `<surface> @ <viewport>`. */
	readonly title: string;
	/** The verified hosted URL, never a local path. */
	readonly url: string;
	readonly sha256: string;
}

/** A hosted capture a reader must be able to open, and the digest of the bytes it must serve. */
export interface Evidence {
	readonly url: string;
	readonly sha256: string;
}

export type GalleryRead =
	| {readonly _tag: "Found"; readonly evidence: readonly [Evidence, ...Evidence[]]}
	/** Nothing a reader could open can be proven from these bytes. */
	| {readonly _tag: "Unprovable"; readonly reason: string};

const digestLine = (sha256: string): string => `<!-- fabrika:evidence sha256=${sha256} -->`;

const IMAGE = /^!\[[^\]\n]*\]\((https:\/\/[^\s)]+)\)$/;
const DIGEST = /^<!-- fabrika:evidence sha256=([0-9a-f]{64}) -->$/;

/** PURE: the gallery section, each image followed by its digest line. */
export const emit = (shots: ReadonlyArray<Shot>): string =>
	[
		HEADING,
		"",
		...shots.flatMap((shot) => [
			`### ${shot.title}`,
			"",
			`![${shot.title}](${shot.url})`,
			digestLine(shot.sha256),
			"",
		]),
	]
		.join("\n")
		.replace(/\n+$/, "");

/**
 * PURE: the evidence the verdict in force embeds, read from the last gallery above the fence.
 *
 * An image with no digest line after it cannot be held to any bytes, so the whole read is
 * unprovable rather than a partial answer: a verdict whose evidence is half-checkable is not one a
 * gate can count.
 */
export const read = (body: string): GalleryRead => {
	const lines = split(body).live.replaceAll("\r\n", "\n").split("\n");
	const start = lines.lastIndexOf(HEADING);
	if (start === -1) {
		return {_tag: "Unprovable", reason: "the verdict carries no evidence gallery"};
	}
	const evidence: Evidence[] = [];
	const section = lines.slice(start + 1);
	for (const [index, line] of section.entries()) {
		const image = IMAGE.exec(line.trim());
		if (image === null) continue;
		const url = image[1] ?? "";
		const digest = DIGEST.exec((section[index + 1] ?? "").trim());
		if (digest === null) {
			return {
				_tag: "Unprovable",
				reason: `${url} carries no sha256 line, so it cannot be held to the judged bytes`,
			};
		}
		evidence.push({url, sha256: digest[1] ?? ""});
	}
	const [first, ...rest] = evidence;
	return first === undefined
		? {_tag: "Unprovable", reason: "the evidence gallery embeds no hosted capture"}
		: {_tag: "Found", evidence: [first, ...rest]};
};
