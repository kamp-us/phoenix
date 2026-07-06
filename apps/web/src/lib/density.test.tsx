import {act, render} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DensityProvider, useDensity} from "./density";
import {DENSITY_STORAGE_KEY} from "./densityStorage";

// jsdom in the `client` tier ships no localStorage (Node's is experimental/off), so the
// provider's persistence seam has nothing to read/write against by default. Install a
// fake Storage on `window` per test so the mount-read and the setChoice-write are
// observable — the same fake-Storage shape themeStorage's unit test uses.
function installFakeStorage(initial?: Record<string, string>): Storage {
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

function Probe() {
	const {setChoice} = useDensity();
	return (
		<button type="button" onClick={() => setChoice("spacious")}>
			set
		</button>
	);
}

describe("DensityProvider", () => {
	beforeEach(() => {
		delete document.documentElement.dataset.density;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		delete document.documentElement.dataset.density;
	});

	it("sets [data-density] on the document root from the persisted choice on mount", () => {
		installFakeStorage({[DENSITY_STORAGE_KEY]: "normal"});
		render(
			<DensityProvider>
				<Probe />
			</DensityProvider>,
		);
		expect(document.documentElement.dataset.density).toBe("normal");
	});

	it("defaults to compact when nothing is persisted", () => {
		installFakeStorage();
		render(
			<DensityProvider>
				<Probe />
			</DensityProvider>,
		);
		expect(document.documentElement.dataset.density).toBe("compact");
	});

	it("updates [data-density] live and persists on setChoice", () => {
		const storage = installFakeStorage();
		const {getByText} = render(
			<DensityProvider>
				<Probe />
			</DensityProvider>,
		);
		act(() => {
			getByText("set").click();
		});
		expect(document.documentElement.dataset.density).toBe("spacious");
		expect(storage.getItem(DENSITY_STORAGE_KEY)).toBe("spacious");
	});
});
