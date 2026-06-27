/**
 * Client-side draft autosave store — persists in-progress writing to localStorage
 * keyed by route, so a signed-out user does not lose a draft across the
 * sign-out → /auth → return round-trip. localStorage only; server-side draft
 * persistence (pano's `saveDraft`) is a separate path, out of scope here.
 *
 * Pure over an injected `Storage` (the themeStorage idiom) so the save → restore →
 * clear lifecycle is unit-testable without a DOM. The React glue is `useDraftAutosave`.
 */

const DRAFT_KEY_PREFIX = "kampus.draft:";

/** The localStorage key a route's draft lives under. Distinct routes never collide. */
export function draftKey(route: string): string {
	return `${DRAFT_KEY_PREFIX}${route}`;
}

/**
 * Read + validate the persisted draft for `route`, falling back to `null` for a
 * missing entry, unparseable/shape-mismatched JSON, or unavailable/throwing storage.
 * The caller's `isValid` guard keeps a stale or hand-tampered payload from being
 * offered as a draft of the wrong shape.
 */
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

/** Persist a draft for `route`. A throwing/unavailable storage (private mode, quota) is swallowed. */
export function writeDraft<T>(storage: Storage | undefined, route: string, draft: T): void {
	if (!storage) return;
	try {
		storage.setItem(draftKey(route), JSON.stringify(draft));
	} catch {
		// A failed write only costs persistence, never the in-memory draft.
	}
}

/** Remove the persisted draft for `route` — on successful submit, or when the offer is dismissed. */
export function clearDraft(storage: Storage | undefined, route: string): void {
	if (!storage) return;
	try {
		storage.removeItem(draftKey(route));
	} catch {
		// A failed clear only leaves a stale draft to be re-offered; never throws into the UI.
	}
}
