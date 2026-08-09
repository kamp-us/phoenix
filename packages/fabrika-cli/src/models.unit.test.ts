import {describe, expect, it} from "vitest";
import {
	ALLOWLIST,
	canonicalModel,
	DEFAULT_PIN,
	isAllowlisted,
	MODEL_ALIASES,
	normalizeModel,
} from "./models.ts";

describe("the model vocabulary", () => {
	it("keeps the default pin inside the allowlist — a pin nothing admits would deny every unset spawn", () => {
		expect(ALLOWLIST).toContain(DEFAULT_PIN);
	});

	it("maps every alias onto a canonical id the allowlist holds", () => {
		expect(Object.keys(MODEL_ALIASES).length).toBeGreaterThan(0);
		for (const canonical of Object.values(MODEL_ALIASES)) {
			expect(ALLOWLIST).toContain(canonical);
		}
	});

	it.each([
		["opus", "claude-opus-4-8"],
		["opus[1m]", "claude-opus-4-8[1m]"],
	])("canonicalizes the harness alias %s", (alias, canonical) => {
		expect(canonicalModel(alias)).toBe(canonical);
		expect(isAllowlisted(alias)).toBe(true);
	});

	it.each([
		"claude-opus-4-8",
		"sonnet",
		"fable-5",
		"a-model-nobody-has-heard-of",
	])("passes %s through unchanged — an unknown model is judged by the allowlist, never rejected here", (model) => {
		expect(canonicalModel(model)).toBe(model);
	});

	it("does not admit a model that is merely alias-shaped", () => {
		expect(isAllowlisted("sonnet")).toBe(false);
		expect(isAllowlisted("haiku")).toBe(false);
	});

	it.each([null, undefined, "", "   "])("reads %p as no model at all", (value) => {
		expect(normalizeModel(value)).toBeNull();
		expect(canonicalModel(value)).toBeNull();
		expect(isAllowlisted(value)).toBe(false);
	});
});
