/**
 * The `flagCache` seed contract (#2828) — the persisted first-paint seed that kills
 * the mecmua topnav false→true pop-in. Pure, storage-injected, no DOM (the repo's
 * pure-extraction idiom, mirroring `densityStorage`): the load-bearing edges are the
 * safe-default fallbacks (missing / garbage / throwing storage) and the exact
 * true/false round-trip, since a wrong fallback would either reintroduce the shift or
 * flash a killed flag on.
 */
import {describe, expect, it} from "vitest";
import {flagCacheKey, readCachedFlag, writeCachedFlag} from "./flagCache";

/** A minimal in-memory Storage stand-in (only the two methods the cache touches). */
function fakeStorage(seed: Record<string, string> = {}): Storage {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
		clear: () => map.clear(),
		key: (i) => Array.from(map.keys())[i] ?? null,
		get length() {
			return map.size;
		},
	} as Storage;
}

/** A Storage whose read/write throw — private mode / quota / disabled storage. */
function throwingStorage(): Storage {
	const deny = () => {
		throw new Error("denied");
	};
	return {
		getItem: deny,
		setItem: deny,
		removeItem: deny,
		clear: deny,
		key: () => null,
		length: 0,
	} as Storage;
}

describe("flagCache — persisted flag seed", () => {
	it("namespaces the storage key per flag key", () => {
		expect(flagCacheKey("mecmua-public-read")).toBe("kampus.flag.mecmua-public-read");
	});

	it("reads back a persisted true/false round-trip", () => {
		const storage = fakeStorage();
		writeCachedFlag(storage, "mecmua-public-read", true);
		expect(readCachedFlag(storage, "mecmua-public-read", false)).toBe(true);
		writeCachedFlag(storage, "mecmua-public-read", false);
		expect(readCachedFlag(storage, "mecmua-public-read", true)).toBe(false);
	});

	it("falls back to the default for a missing entry (first-ever visit)", () => {
		expect(readCachedFlag(fakeStorage(), "mecmua-public-read", false)).toBe(false);
		expect(readCachedFlag(fakeStorage(), "mecmua-public-read", true)).toBe(true);
	});

	it("falls back to the default for a garbage entry rather than coercing truthy", () => {
		const storage = fakeStorage({"kampus.flag.mecmua-public-read": "yes"});
		expect(readCachedFlag(storage, "mecmua-public-read", false)).toBe(false);
	});

	it("falls back to the default when storage is unavailable", () => {
		expect(readCachedFlag(undefined, "mecmua-public-read", false)).toBe(false);
		expect(readCachedFlag(undefined, "mecmua-public-read", true)).toBe(true);
	});

	it("swallows a throwing storage on both read and write (private mode)", () => {
		const storage = throwingStorage();
		expect(readCachedFlag(storage, "mecmua-public-read", true)).toBe(true);
		expect(() => writeCachedFlag(storage, "mecmua-public-read", true)).not.toThrow();
	});
});
