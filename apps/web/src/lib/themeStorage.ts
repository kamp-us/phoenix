import type {ThemeChoice} from "./theme";

export const THEME_STORAGE_KEY = "kampus.theme";

const VALID: ReadonlySet<string> = new Set<ThemeChoice>(["light", "dark", "auto"]);

function isThemeChoice(value: string | null): value is ThemeChoice {
	return value !== null && VALID.has(value);
}

/** Read the persisted choice, falling back to `fallback` for missing/garbage/unavailable storage. */
export function readStoredChoice(storage: Storage | undefined, fallback: ThemeChoice): ThemeChoice {
	if (!storage) return fallback;
	try {
		const raw = storage.getItem(THEME_STORAGE_KEY);
		return isThemeChoice(raw) ? raw : fallback;
	} catch {
		return fallback;
	}
}

/** Persist the choice. A throwing/unavailable storage (private mode, quota) is swallowed. */
export function writeStoredChoice(storage: Storage | undefined, choice: ThemeChoice): void {
	if (!storage) return;
	try {
		storage.setItem(THEME_STORAGE_KEY, choice);
	} catch {
		// A failed write only costs persistence, never the in-memory theme.
	}
}
