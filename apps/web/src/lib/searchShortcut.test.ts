import {describe, expect, it} from "vitest";
import {isSearchShortcut} from "./searchShortcut";

describe("isSearchShortcut", () => {
	it("matches ⌘+K (mac)", () => {
		expect(isSearchShortcut({key: "k", metaKey: true, ctrlKey: false})).toBe(true);
	});

	it("matches Ctrl+K (non-mac)", () => {
		expect(isSearchShortcut({key: "k", metaKey: false, ctrlKey: true})).toBe(true);
	});

	it("matches an uppercase K (e.g. Shift held, or a capitalized key value)", () => {
		expect(isSearchShortcut({key: "K", metaKey: true, ctrlKey: false})).toBe(true);
	});

	it("does not match a bare K (so typing 'k' in a field is untouched)", () => {
		expect(isSearchShortcut({key: "k", metaKey: false, ctrlKey: false})).toBe(false);
	});

	it("does not match ⌘ with a non-K key", () => {
		expect(isSearchShortcut({key: "a", metaKey: true, ctrlKey: false})).toBe(false);
		expect(isSearchShortcut({key: "Enter", metaKey: false, ctrlKey: true})).toBe(false);
	});
});
