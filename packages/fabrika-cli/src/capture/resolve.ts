/**
 * Resolve an app's preview base URL from the sticky preview-deploy PR comment.
 *
 * The `deploy.yml` "Comment preview URL" step posts ONE sticky comment keyed by
 * the outer `<!-- preview-deploy -->` marker, into which each matrix app upserts
 * its own block under a per-app `<!-- preview-deploy:<app> -->` anchor followed by
 * a human line `- **<app>** — Stage \`pr-<n>\` → <url> …`. `ci.yml` already
 * resolves the web URL by keying off `<!-- preview-deploy:web -->` (its `webRe`).
 *
 * We MUST key off the per-app anchor, NOT grab the first `workers.dev` URL in the
 * comment: a blind first-match breaks the moment a second app's preview line is
 * present (it would return the wrong app's URL). This resolver bounds the scan to
 * the target app's own block (from its anchor up to the next app anchor).
 */

const WORKERS_DEV_URL = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev/;

const ANCHOR_PREFIX = "<!-- preview-deploy:";

/** This app's slice of the sticky comment: its anchor up to the next app's, or `null` if absent. */
const appBlock = (commentBody: string, app: string): string | null => {
	const anchor = `${ANCHOR_PREFIX}${app} -->`;
	const start = commentBody.indexOf(anchor);
	if (start === -1) return null;
	const rest = commentBody.slice(start + anchor.length);
	// Bound to this app's block: stop at the next per-app anchor so a sibling app's
	// URL can never leak into this match.
	const nextAnchor = rest.indexOf(ANCHOR_PREFIX);
	return nextAnchor === -1 ? rest : rest.slice(0, nextAnchor);
};

/**
 * Return the `app` (default `web`) preview URL from the sticky comment body, or
 * `null` if the comment carries no block for that app (deploy absent/failed).
 */
export const resolvePreviewUrl = (commentBody: string, app = "web"): string | null => {
	const block = appBlock(commentBody, app);
	if (block === null) return null;
	const match = WORKERS_DEV_URL.exec(block);
	return match ? match[0] : null;
};

/** Whether the body is a preview announcement at all — the anchor, whatever it announces. */
export const isPreviewAnnouncement = (commentBody: string): boolean =>
	commentBody.includes(ANCHOR_PREFIX);

/** Every app the announcement carries a block for, in the order the comment names them. */
export const announcedApps = (commentBody: string): readonly string[] => {
	const apps: string[] = [];
	const pattern = /<!-- preview-deploy:([a-z0-9][a-z0-9-]*) -->/g;
	for (const match of commentBody.matchAll(pattern)) {
		const app = match[1];
		if (app !== undefined && !apps.includes(app)) apps.push(app);
	}
	return apps;
};

/** What one app's block announces: where the preview is, and which tree it deployed. */
export interface PreviewAnnouncement {
	readonly app: string;
	readonly url: string;
	/** The head SHA the preview deployed — what binds pixels to a tree (ADR 0058). */
	readonly deployedSha: string;
}

/**
 * An announcement read, three ways: the app's block is there and parses, it is there and does not,
 * or the announcement names no such app.
 *
 * `Malformed` and `NoApp` are deliberately separate. A malformed announcement is one nobody can
 * read — an UNKNOWN — while an absent app is a proven fact about what was deployed; folding them
 * would let a garbled comment resolve to "no preview" and route a reviewer down the can't-see path.
 */
export type AnnouncementRead =
	| {readonly _tag: "Announced"; readonly value: PreviewAnnouncement}
	| {readonly _tag: "Malformed"; readonly reason: string}
	| {readonly _tag: "NoApp"};

/** Any absolute http(s) URL — the announcement's domain is the repo's business, not this module's. */
const ANY_URL = /https?:\/\/[^\s<>()"'`\]]+/;
const EVERY_URL = new RegExp(ANY_URL.source, "g");
/**
 * The deployed head SHA, read only in an **anchored** form — `@ <sha>`, `(<sha>)` (the shape
 * phoenix's own deploy comment upserts), a backticked SHA, or `head <sha>`.
 *
 * A bare hex-looking word is deliberately not read as a SHA: ordinary English words spell in hex
 * (`defaced`), and a wrong SHA here would bind pixels to a tree nobody deployed.
 */
const DEPLOYED_SHA = /(?:@|\(|`|\bhead\b)[ \t]*`?([0-9a-f]{7,40})`?/i;

/**
 * Read one app's announced preview URL + deployed head out of the sticky comment.
 *
 * Keyed off the per-app anchor for the reason {@link resolvePreviewUrl} states, and domain-agnostic
 * where that older reader hardcodes `workers.dev`: an adopter repo's preview lives wherever its
 * delivery layer puts it, and a hardcoded domain silently reads such a comment as no comment.
 */
export const readPreviewAnnouncement = (commentBody: string, app: string): AnnouncementRead => {
	const block = appBlock(commentBody, app);
	if (block === null) return {_tag: "NoApp"};
	const url = ANY_URL.exec(block)?.[0];
	if (url === undefined) {
		return {_tag: "Malformed", reason: `the "${app}" block names no absolute http(s) URL`};
	}
	// The URLs come out first: a hex-looking path segment inside one is not a deployed head.
	const sha = DEPLOYED_SHA.exec(block.replace(EVERY_URL, " "))?.[1];
	if (sha === undefined) {
		return {
			_tag: "Malformed",
			reason: `the "${app}" block names no deployed head SHA (expected \`@ <sha>\`, a backticked SHA, or "head <sha>")`,
		};
	}
	return {_tag: "Announced", value: {app, url, deployedSha: sha.toLowerCase()}};
};
