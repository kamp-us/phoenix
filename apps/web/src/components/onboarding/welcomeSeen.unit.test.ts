/**
 * The shown-once marker's contract (#7043), pinned without a DOM — storage is injected.
 * The user-id keying is the load-bearing half: accounts on one browser must never
 * suppress each other's welcome.
 */
import {describe, expect, it} from "vitest";
import {hasSeenWelcome, markWelcomeSeen, WELCOME_SEEN_SCHEMA, welcomeSeenKey} from "./welcomeSeen";

interface MemoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function storageOver(store: Map<string, string>): MemoryStorage {
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
	};
}

function memoryStorage(): MemoryStorage & {readonly store: Map<string, string>} {
	const store = new Map<string, string>();
	return {...storageOver(store), store};
}

describe("welcomeSeen — the per-account shown-once marker", () => {
	it("starts unseen for an account with no marker", () => {
		expect(hasSeenWelcome(memoryStorage(), "u-1")).toBe(false);
	});

	it("marks seen and reads back seen", () => {
		const storage = memoryStorage();
		markWelcomeSeen(storage, "u-1");
		expect(hasSeenWelcome(storage, "u-1")).toBe(true);
	});

	it("is idempotent — marking twice changes nothing", () => {
		const storage = memoryStorage();
		markWelcomeSeen(storage, "u-1");
		markWelcomeSeen(storage, "u-1");
		expect(hasSeenWelcome(storage, "u-1")).toBe(true);
	});

	it("keys by account, so a second account on the same browser is still unseen", () => {
		const storage = memoryStorage();
		markWelcomeSeen(storage, "u-1");
		expect(hasSeenWelcome(storage, "u-2")).toBe(false);
	});

	it("survives a fresh handle over the same backing store — a reload re-reads the marker", () => {
		const before = memoryStorage();
		markWelcomeSeen(before, "u-1");
		// A reload builds a brand-new wrapper over the browser's persisted store.
		expect(hasSeenWelcome(storageOver(before.store), "u-1")).toBe(true);
	});

	it("repeat login is the same read — no session state involved", () => {
		const storage = memoryStorage();
		markWelcomeSeen(storage, "u-1");
		expect(hasSeenWelcome(storage, "u-1")).toBe(true);
	});

	it("a foreign value at the key never reads as seen", () => {
		const storage = memoryStorage();
		storage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u-1"), "yes");
		expect(hasSeenWelcome(storage, "u-1")).toBe(false);
	});

	it("no storage or no account degrades to unseen — and writing is a no-op", () => {
		expect(hasSeenWelcome(null, "u-1")).toBe(false);
		expect(hasSeenWelcome(memoryStorage(), null)).toBe(false);
		expect(() => markWelcomeSeen(null, "u-1")).not.toThrow();
		expect(() => markWelcomeSeen(memoryStorage(), null)).not.toThrow();
	});

	it("a refusing storage degrades to unseen instead of throwing through the arrival", () => {
		const refusing: MemoryStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(() => markWelcomeSeen(refusing, "u-1")).not.toThrow();
	});
});
