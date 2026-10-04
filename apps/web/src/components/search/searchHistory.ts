import {MIN_SEARCH_LENGTH} from "../../lib/searchTarget";

export const SEARCH_HISTORY_STORAGE_KEY = "kampus.search.history";
/** The zero-query frame stays a wayfinder, not an unbounded activity log. */
export const SEARCH_HISTORY_LIMIT = 5;

function normalize(query: string): string {
	return query.trim();
}

function isStoredHistory(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= SEARCH_HISTORY_LIMIT &&
		value.every(
			(query) =>
				typeof query === "string" &&
				query === normalize(query) &&
				query.length >= MIN_SEARCH_LENGTH,
		)
	);
}

export function readSearchHistory(storage: Storage | undefined): readonly string[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(SEARCH_HISTORY_STORAGE_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		return isStoredHistory(parsed) ? [...new Set(parsed)] : [];
	} catch {
		return [];
	}
}

/** Returns the durable list, or `[]` when this device refuses persistence. */
export function rememberSearch(storage: Storage | undefined, rawQuery: string): readonly string[] {
	if (!storage) return [];
	const query = normalize(rawQuery);
	if (query.length < MIN_SEARCH_LENGTH) return readSearchHistory(storage);
	const next = [query, ...readSearchHistory(storage).filter((item) => item !== query)].slice(
		0,
		SEARCH_HISTORY_LIMIT,
	);
	try {
		storage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
		return next;
	} catch {
		return [];
	}
}
