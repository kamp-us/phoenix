import {describe, expect, it} from "vitest";
import {DENSITY_STORAGE_KEY, readStoredDensity, writeStoredDensity} from "./densityStorage";

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

describe("densityStorage", () => {
	it("rehydrates a chosen density written earlier (the round-trip)", () => {
		const storage = fakeStorage();
		writeStoredDensity(storage, "spacious");
		expect(storage.getItem(DENSITY_STORAGE_KEY)).toBe("spacious");
		expect(readStoredDensity(storage, "compact")).toBe("spacious");
	});

	it("persists each of the three valid choices", () => {
		const storage = fakeStorage();
		for (const choice of ["compact", "normal", "spacious"] as const) {
			writeStoredDensity(storage, choice);
			expect(readStoredDensity(storage, "compact")).toBe(choice);
		}
	});

	it("falls back to compact when nothing is stored", () => {
		expect(readStoredDensity(fakeStorage(), "compact")).toBe("compact");
	});

	it("falls back when the stored value is not a valid choice", () => {
		const storage = fakeStorage({[DENSITY_STORAGE_KEY]: "cozy"});
		expect(readStoredDensity(storage, "compact")).toBe("compact");
	});

	it("falls back (never throws) when storage is unavailable", () => {
		expect(readStoredDensity(undefined, "normal")).toBe("normal");
		expect(() => writeStoredDensity(undefined, "spacious")).not.toThrow();
	});

	it("swallows a throwing storage rather than losing the in-memory density", () => {
		const broken: Storage = {
			...fakeStorage(),
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(readStoredDensity(broken, "compact")).toBe("compact");
		expect(() => writeStoredDensity(broken, "spacious")).not.toThrow();
	});
});
