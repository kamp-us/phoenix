import {describe, expect, it} from "vitest";
import {isSubmitShortcut} from "./submitShortcut";

describe("isSubmitShortcut", () => {
	it("matches ⌘+Enter (mac)", () => {
		expect(isSubmitShortcut({key: "Enter", metaKey: true, ctrlKey: false})).toBe(true);
	});

	it("matches Ctrl+Enter (non-mac)", () => {
		expect(isSubmitShortcut({key: "Enter", metaKey: false, ctrlKey: true})).toBe(true);
	});

	it("does not match plain Enter (so the textarea keeps inserting a newline)", () => {
		expect(isSubmitShortcut({key: "Enter", metaKey: false, ctrlKey: false})).toBe(false);
	});

	it("does not match ⌘ with a non-Enter key", () => {
		expect(isSubmitShortcut({key: "a", metaKey: true, ctrlKey: false})).toBe(false);
		expect(isSubmitShortcut({key: "Backspace", metaKey: false, ctrlKey: true})).toBe(false);
	});
});
