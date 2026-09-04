import {describe, expect, it} from "vitest";
import {LOCALE_STORAGE_KEY, readStoredLocale, writeStoredLocale} from "./localeStorage";

// The `themeStorage.unit.test.ts` fake, one-for-one — the two modules share a shape.
function memoryStorage(initial?: Record<string, string>): Storage {
	const map = new Map<string, string>(Object.entries(initial ?? {}));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k) => map.get(k) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (k) => void map.delete(k),
		setItem: (k, v) => void map.set(k, v),
	};
}

function throwingStorage(): Storage {
	return {
		...memoryStorage(),
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
	};
}

describe("localeStorage", () => {
	it("stores under kampus.locale, beside kampus.theme", () => {
		expect(LOCALE_STORAGE_KEY).toBe("kampus.locale");
	});

	it("reads back a valid stored locale", () => {
		expect(readStoredLocale(memoryStorage({[LOCALE_STORAGE_KEY]: "en"}), "tr")).toBe("en");
	});

	it("falls back on an absent, unknown or malformed value", () => {
		expect(readStoredLocale(memoryStorage(), "tr")).toBe("tr");
		expect(readStoredLocale(memoryStorage({[LOCALE_STORAGE_KEY]: "de"}), "tr")).toBe("tr");
		expect(readStoredLocale(memoryStorage({[LOCALE_STORAGE_KEY]: ""}), "tr")).toBe("tr");
	});

	it("falls back with no storage at all (SSR / a worker isolate)", () => {
		expect(readStoredLocale(undefined, "tr")).toBe("tr");
	});

	it("round-trips a write", () => {
		const storage = memoryStorage();
		writeStoredLocale(storage, "en");
		expect(readStoredLocale(storage, "tr")).toBe("en");
	});

	it("swallows a storage that throws, on both directions", () => {
		const storage = throwingStorage();
		expect(readStoredLocale(storage, "tr")).toBe("tr");
		expect(() => writeStoredLocale(storage, "en")).not.toThrow();
		expect(() => writeStoredLocale(undefined, "en")).not.toThrow();
	});
});
