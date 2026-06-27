/**
 * The Karma atom's accessible-name contract (#1208). `karmaAriaLabel` is the
 * atom's labeling decision factored DOM-free, asserted here — the pure-extraction
 * idiom of `flagGateChild` (`apps/web/src` has no jsdom/testing-library).
 */
import {describe, expect, it} from "vitest";
import {karmaAriaLabel} from "./Karma";

describe("karmaAriaLabel — the Karma atom's accessible name", () => {
	it("labels a bare karma value", () => {
		expect(karmaAriaLabel(42, undefined, "karma")).toBe("karma: 42");
	});

	it("reads a zero-karma çaylak honestly as 0, not a placeholder", () => {
		// AC #1208: a zero-karma çaylak shows the real number, never a "yeni üye"
		// stand-in that contradicts it.
		expect(karmaAriaLabel(0, undefined, "karma")).toBe("karma: 0");
	});

	it("labels the progress form as 'value / target' (the #1291 promotion bar)", () => {
		expect(karmaAriaLabel(5, 10, "karma")).toBe("karma: 5 / 10");
	});

	it("honors a custom label noun", () => {
		expect(karmaAriaLabel(3, undefined, "puan")).toBe("puan: 3");
	});
});
