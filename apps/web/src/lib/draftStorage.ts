/**
 * Client-side draft autosave store — keeps a draft alive across the
 * sign-out → /auth → return round-trip. Server-side draft persistence (pano's
 * `saveDraft`) is a separate path, not this one. React glue: `useDraftAutosave`.
 */

const DRAFT_KEY_PREFIX = "kampus.draft:";

export function draftKey(route: string): string {
	return `${DRAFT_KEY_PREFIX}${route}`;
}

export function readDraft<T>(
	storage: Storage | undefined,
	route: string,
	isValid: (value: unknown) => value is T,
): T | null {
	if (!storage) return null;
	try {
		const raw = storage.getItem(draftKey(route));
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		return isValid(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function writeDraft<T>(storage: Storage | undefined, route: string, draft: T): void {
	if (!storage) return;
	try {
		storage.setItem(draftKey(route), JSON.stringify(draft));
	} catch {
		// A failed write only costs persistence, never the in-memory draft.
	}
}

export function clearDraft(storage: Storage | undefined, route: string): void {
	if (!storage) return;
	try {
		storage.removeItem(draftKey(route));
	} catch {
		// A failed clear only leaves a stale draft to be re-offered; never throws into the UI.
	}
}
