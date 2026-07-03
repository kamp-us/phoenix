/**
 * The wire contract for `GET /api/pano/link-metadata` (#1642) — the pano
 * submit form's title/description prefill seam. The client passes a `url`
 * query param; the worker fetches it server-side (the browser can't fetch
 * cross-origin HTML), parses the page metadata, and returns this shape.
 *
 * Like `evaluate-contract.ts`, the shared type + the client-side response
 * parse live here as pure functions so they're unit-testable without a DOM.
 * The response is always safe-default: any fetch failure, timeout, SSRF
 * rejection, or a page with no usable metadata yields `{}` (a graceful no-op,
 * never a surfaced error), and a missing/non-string field parses to absent —
 * so a flaky target page can only ever leave the form fields untouched.
 */

/** The parsed page metadata the prefill route returns. Both fields optional. */
export interface LinkMetadata {
	readonly title?: string;
	readonly description?: string;
}

/**
 * Parse an untrusted `/api/pano/link-metadata` response body into
 * {@link LinkMetadata}, dropping any non-string field. The input is `unknown`
 * on purpose — it comes from `res.json()` — so this structural guard, not a
 * cast at the call site, is what enforces the client's safe-default contract:
 * only a genuine non-empty string survives; everything else collapses to
 * absent, and the field is then never prefilled.
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
