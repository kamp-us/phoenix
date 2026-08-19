/**
 * `null` means "do not navigate": a bare Enter stays put, and a query below the
 * backend's 2-char minimum (ADR 0080) would only reach a dead results page.
 */

const MIN_QUERY_LENGTH = 2;

export function searchTarget(raw: string): string | null {
	const query = raw.trim();
	if (query.length < MIN_QUERY_LENGTH) return null;
	return `/search?q=${encodeURIComponent(query)}`;
}
