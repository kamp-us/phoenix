/**
 * `null` means "do not navigate": a bare Enter stays put, and a query below the
 * backend's 2-char minimum (ADR 0080) would only reach a dead results page.
 */

/** The backend's floor (ADR 0080). The ⌘K palette reads it too — one minimum, one source. */
export const MIN_SEARCH_LENGTH = 2;

export function searchTarget(raw: string): string | null {
	const query = raw.trim();
	if (query.length < MIN_SEARCH_LENGTH) return null;
	return `/search?q=${encodeURIComponent(query)}`;
}
