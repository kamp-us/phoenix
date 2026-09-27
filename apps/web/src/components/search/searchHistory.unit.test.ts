import {describe, expect, it} from "vitest";
import {
	readSearchHistory,
	rememberSearch,
	SEARCH_HISTORY_LIMIT,
	SEARCH_HISTORY_STORAGE_KEY,
} from "./searchHistory";

function memoryStorage(initial?: Record<string, string>): Storage {
	const map = new Map<string, string>(Object.entries(initial ?? {}));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (index) => [...map.keys()][index] ?? null,
		removeItem: (key) => void map.delete(key),
		setItem: (key, value) => void map.set(key, value),
	};
}

describe("searchHistory", () => {
	it("keeps unique submitted queries most-recent-first and capped at five", () => {
		const storage = memoryStorage();
		for (let index = 0; index <= SEARCH_HISTORY_LIMIT; index += 1) {
			rememberSearch(storage, `query ${index}`);
		}
		expect(readSearchHistory(storage)).toEqual([
			"query 5",
			"query 4",
			"query 3",
			"query 2",
			"query 1",
		]);

		rememberSearch(storage, " query 3 ");
		expect(readSearchHistory(storage)).toEqual([
			"query 3",
			"query 5",
			"query 4",
			"query 2",
			"query 1",
		]);
	});

	it("rejects malformed persisted data and queries below the search minimum", () => {
		const malformed = memoryStorage({[SEARCH_HISTORY_STORAGE_KEY]: JSON.stringify(["valid", 4])});
		expect(readSearchHistory(malformed)).toEqual([]);

		const storage = memoryStorage();
		expect(rememberSearch(storage, "a")).toEqual([]);
		expect(storage.getItem(SEARCH_HISTORY_STORAGE_KEY)).toBeNull();
	});

	it("degrades to an empty history when storage is missing or throws", () => {
		const refusing: Storage = {
			...memoryStorage(),
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(readSearchHistory(undefined)).toEqual([]);
		expect(readSearchHistory(refusing)).toEqual([]);
		expect(rememberSearch(undefined, "effect")).toEqual([]);
		expect(rememberSearch(refusing, "effect")).toEqual([]);
	});
});
