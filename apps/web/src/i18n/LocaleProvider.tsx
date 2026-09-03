/**
 * `LocaleProvider` / `useLocale` / `useT` — the React face of the catalog (ADR 0347).
 *
 * Persistence mirrors `lib/theme`: the choice lives under `kampus.locale`, read through
 * `lib/localeStorage`, defaulting to `tr`.
 */
import * as React from "react";
import {readStoredLocale, writeStoredLocale} from "../lib/localeStorage";
import {type Catalog, loadCatalog, trCatalog} from "./catalog";
import {interpolate, type MessageParams} from "./interpolate";
import type {CatalogKey} from "./keys";
import {DEFAULT_LOCALE, type Locale} from "./locale";

export type Translate = (key: CatalogKey, params?: MessageParams) => string;

export interface LocaleContextValue {
	readonly locale: Locale;
	readonly setLocale: (locale: Locale) => void;
	readonly t: Translate;
}

function translateWith(catalog: Catalog): Translate {
	return (key, params) => interpolate(catalog[key], params);
}

// Unlike `useTheme`, reading this outside a provider does NOT throw: the layout primitives are
// rendered standalone (tests, the atölye exhibits), and `tr` is the default locale, so the
// context default is the same copy the provider would hand them.
const LocaleContext = React.createContext<LocaleContextValue>({
	locale: DEFAULT_LOCALE,
	setLocale: () => {},
	t: translateWith(trCatalog),
});

function browserStorage(): Storage | undefined {
	return typeof window === "undefined" ? undefined : window.localStorage;
}

export function LocaleProvider({children}: {children: React.ReactNode}) {
	const [locale, setLocaleState] = React.useState<Locale>(() =>
		readStoredLocale(browserStorage(), DEFAULT_LOCALE),
	);
	const [catalog, setCatalog] = React.useState<Catalog>(trCatalog);

	// `document.lang` flips with the catalog, not ahead of it: `en` arrives over a dynamic
	// import, and announcing English while Turkish is still painted would mislead a screen
	// reader for that frame. A failed chunk load holds both at the Turkish they already carry.
	React.useEffect(() => {
		if (locale === DEFAULT_LOCALE) {
			setCatalog(trCatalog);
			document.documentElement.lang = DEFAULT_LOCALE;
			return;
		}
		let active = true;
		loadCatalog(locale)
			.then((loaded) => {
				if (!active) return;
				setCatalog(loaded);
				document.documentElement.lang = locale;
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [locale]);

	const setLocale = React.useCallback((next: Locale) => {
		writeStoredLocale(browserStorage(), next);
		setLocaleState(next);
	}, []);

	const value = React.useMemo<LocaleContextValue>(
		() => ({locale, setLocale, t: translateWith(catalog)}),
		[locale, setLocale, catalog],
	);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
	return React.useContext(LocaleContext);
}

export function useT(): Translate {
	return React.useContext(LocaleContext).t;
}
