import {describe, expect, it} from "vitest";
import {readStoredChoice, THEME_STORAGE_KEY, writeStoredChoice} from "./themeStorage";

function fakeStorage(initial?: Record<string, string>): Storage {
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

describe("themeStorage", () => {
	it("rehydrates a chosen theme written earlier (the #697 round-trip)", () => {
		const storage = fakeStorage();
		writeStoredChoice(storage, "light");
		expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
		expect(readStoredChoice(storage, "dark")).toBe("light");
	});

	it("persists each of the three valid choices", () => {
		const storage = fakeStorage();
		for (const choice of ["light", "dark", "auto"] as const) {
			writeStoredChoice(storage, choice);
			expect(readStoredChoice(storage, "dark")).toBe(choice);
		}
	});

	it("falls back when nothing is stored", () => {
		expect(readStoredChoice(fakeStorage(), "auto")).toBe("auto");
	});

	it("falls back when the stored value is not a valid choice", () => {
		const storage = fakeStorage({[THEME_STORAGE_KEY]: "neon"});
		expect(readStoredChoice(storage, "dark")).toBe("dark");
	});

	it("falls back (never throws) when storage is unavailable", () => {
		expect(readStoredChoice(undefined, "light")).toBe("light");
		expect(() => writeStoredChoice(undefined, "dark")).not.toThrow();
	});

	it("swallows a throwing storage rather than losing the in-memory theme", () => {
		const broken: Storage = {
			...fakeStorage(),
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(readStoredChoice(broken, "auto")).toBe("auto");
		expect(() => writeStoredChoice(broken, "light")).not.toThrow();
	});
});
