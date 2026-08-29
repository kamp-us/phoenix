/**
 * An in-memory `Storage` for the `client` vitest tier, which ships no `localStorage` of its
 * own — bare `localStorage.x` there is `undefined` and every access throws (#7043).
 *
 * Installed on BOTH the bare global and `window`: production readers split across the two
 * (`welcomeSeen.ts` goes through `window.localStorage`, test setup calls bare `localStorage`),
 * and stubbing one leaves the other undefined.
 */
import {vi} from "vitest";

export function installFakeStorage(initial?: Record<string, string>): Storage {
	const map = new Map<string, string>(Object.entries(initial ?? {}));
	const storage: Storage = {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k) => map.get(k) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (k) => void map.delete(k),
		setItem: (k, v) => void map.set(k, v),
	};
	vi.stubGlobal("localStorage", storage);
	Object.defineProperty(window, "localStorage", {value: storage, configurable: true});
	return storage;
}
