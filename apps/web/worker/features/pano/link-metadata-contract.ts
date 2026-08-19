/**
 * The wire contract for `GET /api/pano/link-metadata` (#1642), the submit form's prefill
 * seam. The fetch is server-side because a browser can't fetch cross-origin HTML. Always
 * safe-default: a fetch failure, timeout, SSRF rejection, or a page with no usable
 * metadata all yield `{}`, never a surfaced error, so a flaky target page can only leave
 * the form untouched.
 */

export interface LinkMetadata {
	readonly title?: string;
	readonly description?: string;
}

/**
 * The input is `unknown` on purpose — it comes from `res.json()` — so this structural
 * guard, not a cast at the call site, is what enforces the safe-default contract.
 */
export function parseLinkMetadataResponse(body: unknown): LinkMetadata {
	if (typeof body !== "object" || body === null) return {};
	const {title, description} = body as {title?: unknown; description?: unknown};
	const result: {title?: string; description?: string} = {};
	if (typeof title === "string" && title.trim() !== "") result.title = title;
	if (typeof description === "string" && description.trim() !== "")
		result.description = description;
	return result;
}
