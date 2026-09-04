import {isLocale, type Locale} from "../i18n/locale";

export const LOCALE_STORAGE_KEY = "kampus.locale";

export function readStoredLocale(storage: Storage | undefined, fallback: Locale): Locale {
	if (!storage) return fallback;
	try {
		const raw = storage.getItem(LOCALE_STORAGE_KEY);
		return isLocale(raw) ? raw : fallback;
	} catch {
		return fallback;
	}
}

export function writeStoredLocale(storage: Storage | undefined, locale: Locale): void {
	if (!storage) return;
	try {
		storage.setItem(LOCALE_STORAGE_KEY, locale);
	} catch {
		// A failed write only costs persistence, never the in-memory locale.
	}
}
