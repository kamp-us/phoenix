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

/**
 * Return the `app` (default `web`) preview URL from the sticky comment body, or
 * `null` if the comment carries no block for that app (deploy absent/failed).
 */
export const resolvePreviewUrl = (commentBody: string, app = "web"): string | null => {
	const anchor = `<!-- preview-deploy:${app} -->`;
	const start = commentBody.indexOf(anchor);
	if (start === -1) return null;
	const rest = commentBody.slice(start + anchor.length);
	// Bound to this app's block: stop at the next per-app anchor so a sibling app's
	// URL can never leak into this match.
	const nextAnchor = rest.indexOf("<!-- preview-deploy:");
	const block = nextAnchor === -1 ? rest : rest.slice(0, nextAnchor);
	const match = WORKERS_DEV_URL.exec(block);
	return match ? match[0] : null;
};
