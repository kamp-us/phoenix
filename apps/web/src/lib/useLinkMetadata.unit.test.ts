/**
 * The shared prefill policy (#1642): `prefillIfEmpty` is the single definition
 * of "write a form field ONLY when it is still empty/untouched", used by both
 * pano submit surfaces so neither can clobber user input. Tested pure, without a
 * DOM.
 */
import {describe, expect, it, vi} from "vitest";
import {PREFILL_MAX_LEN, prefillIfEmpty} from "./useLinkMetadata";

describe("prefillIfEmpty", () => {
	it("sets the field when it is empty", () => {
		const set = vi.fn();
		prefillIfEmpty("", "Fetched Title", set);
		expect(set).toHaveBeenCalledWith("Fetched Title");
	});

	it("sets the field when it holds only whitespace (untouched)", () => {
		const set = vi.fn();
		prefillIfEmpty("   ", "Fetched Title", set);
		expect(set).toHaveBeenCalledWith("Fetched Title");
	});

	it("never clobbers a field the user already edited", () => {
		const set = vi.fn();
		prefillIfEmpty("my own title", "Fetched Title", set);
		expect(set).not.toHaveBeenCalled();
	});

	it("does nothing when there is no fetched value", () => {
		const set = vi.fn();
		prefillIfEmpty("", undefined, set);
		prefillIfEmpty("", "", set);
		expect(set).not.toHaveBeenCalled();
	});

	it("clamps the prefilled value to PREFILL_MAX_LEN", () => {
		const set = vi.fn();
		prefillIfEmpty("", "a".repeat(PREFILL_MAX_LEN + 50), set);
		expect(set).toHaveBeenCalledWith("a".repeat(PREFILL_MAX_LEN));
	});
});
