/**
 * Last-known flag-value cache — the first-paint seed for a persisted `useFlag`
 * (#2828). `useFlag` evaluates server-side over `fetch`, so on a cold render the
 * value starts at its `defaultValue` and only flips once the async read lands — a
 * false→true flip that pops a gated nav slot in *after* the ungated links on every
 * load (the mecmua topnav CLS). Persisting the resolved value and seeding the next
 * render from it collapses that per-load shift to a one-time first-visit cost, with
 * no change to gating: the server evaluate stays authoritative and overwrites both
 * the in-memory value and this cache, so a killed flag self-corrects on the next
 * response. Same seed-to-avoid-flash idiom as `densityStorage` / `theme`.
 *
 * A pure module (storage injected, no `window`) so the seed logic is unit-testable
 * without a DOM, mirroring `densityStorage.ts`.
 */

const KEY_PREFIX = "kampus.flag.";

/** The localStorage key a flag's cached value lives under (namespaced per flag key). */
export function flagCacheKey(flagKey: string): string {
	return `${KEY_PREFIX}${flagKey}`;
}

/**
 * Read the cached boolean for `flagKey`, falling back to `fallback` for a
 * missing/garbage value or an unavailable/throwing storage (private mode, quota).
 * Only the two canonical strings count — anything else is treated as absent so a
 * corrupted entry degrades to the safe default rather than a coerced truthy.
 */
export function readCachedFlag(
	storage: Storage | undefined,
	flagKey: string,
	fallback: boolean,
): boolean {
	if (!storage) return fallback;
	try {
		const raw = storage.getItem(flagCacheKey(flagKey));
		if (raw === "true") return true;
		if (raw === "false") return false;
		return fallback;
	} catch {
		return fallback;
	}
}

/** Persist a flag's resolved value. A throwing/unavailable storage is swallowed. */
export function writeCachedFlag(
	storage: Storage | undefined,
	flagKey: string,
	value: boolean,
): void {
	if (!storage) return;
	try {
		storage.setItem(flagCacheKey(flagKey), value ? "true" : "false");
	} catch {
		// A failed write only costs the next-load seed, never the in-memory value.
	}
}
