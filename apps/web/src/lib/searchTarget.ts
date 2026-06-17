/**
 * Build the `/search?q=…` target for a top-bar search submit, or `null` when the
 * query shouldn't navigate. The Topbar's submit handler routes to this and only
 * navigates on a non-null result, so a bare Enter (empty/whitespace) stays put.
 *
 * Below the backend's 2-char minimum (ADR 0080) there's nothing to resolve — the
 * results page would only render its "en az 2 harf" prompt — so a sub-minimum query
 * is a no-op (`null`) rather than a navigation to an empty/dead search.
 */

const MIN_QUERY_LENGTH = 2;

export function searchTarget(raw: string): string | null {
	const query = raw.trim();
	if (query.length < MIN_QUERY_LENGTH) return null;
	return `/search?q=${encodeURIComponent(query)}`;
}
