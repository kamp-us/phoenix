import {afterEach, describe, expect, it} from "vitest";
import {browserStorage} from "./browserStorage";

function withWindow(value: unknown) {
	Object.defineProperty(globalThis, "window", {value, configurable: true, writable: true});
}

function withThrowingStorage() {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			get localStorage(): Storage {
				throw new DOMException("The operation is insecure.", "SecurityError");
			},
		},
	});
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "window");
});

describe("browserStorage — the guarded window.localStorage read (#7728)", () => {
	it("hands back the storage when the browser has one", () => {
		const storage = {} as Storage;
		withWindow({localStorage: storage});
		expect(browserStorage()).toBe(storage);
	});

	it("is undefined with no window at all (SSR / the node test tier)", () => {
		expect(typeof window).toBe("undefined");
		expect(browserStorage()).toBeUndefined();
	});

	it("is undefined when the runtime leaves localStorage undefined", () => {
		withWindow({localStorage: undefined});
		expect(browserStorage()).toBeUndefined();
	});

	it("swallows the private-window SecurityError the property access itself throws", () => {
		withThrowingStorage();
		expect(() => browserStorage()).not.toThrow();
		expect(browserStorage()).toBeUndefined();
	});
});
