/**
 * Pins the stage-name invariant of `_stage-name.ts`: `[a-z0-9-]` only, no leading/
 * trailing dash, no internal `--`, non-empty — for every input including the empty/
 * punctuation-only basename that used to emit `it--<disc>` (#698).
 */

import {describe, expect, it} from "vitest";
import {DISC_LEN, disc, MAX_STAGE_LEN, slugify, stageName} from "./_stage-name.ts";

const RUN_TOKEN = "run-1";

const assertInvariant = (name: string) => {
	expect(name).toMatch(/^[a-z0-9-]+$/);
	expect(name).not.toMatch(/--/);
	expect(name).not.toMatch(/^-|-$/);
	expect(name.length).toBeGreaterThan(0);
};

describe("slugify", () => {
	it("sanitizes to the [a-z0-9-] set with no leading/trailing dash", () => {
		expect(slugify("Sozluk-Read.cases")).toBe("sozluk-read-cases");
	});

	it("collapses an all-punctuation basename to the empty string", () => {
		expect(slugify("...")).toBe("");
		expect(slugify("")).toBe("");
	});
});

describe("stageName — destroy-on (CI / default)", () => {
	it.each([
		["", "empty slug (punctuation-only basename)"],
		["sozluk-read", "ordinary slug"],
		["a-name-far-longer-than-the-bounded-stage-budget-allows", "over-budget slug"],
	])("upholds the invariant for %s (%s)", (slug) => {
		assertInvariant(stageName(slug, false, RUN_TOKEN));
	});

	it("never emits a double-dash for an empty slug — the #698 regression", () => {
		const name = stageName("", false, RUN_TOKEN);
		expect(name).not.toMatch(/--/);
		expect(name).toBe(`it-${disc(`|${RUN_TOKEN}`)}`);
	});

	it("stays within MAX_STAGE_LEN", () => {
		const long = "x".repeat(100);
		expect(stageName(long, false, RUN_TOKEN).length).toBeLessThanOrEqual(MAX_STAGE_LEN);
	});

	it("is run-unique: the same slug under distinct run tokens differs", () => {
		expect(stageName("seam", false, "run-a")).not.toBe(stageName("seam", false, "run-b"));
	});
});

describe("stageName — NO_DESTROY (stable local re-adopt)", () => {
	it("returns the stable it-<slug> form", () => {
		expect(stageName("seam", true, RUN_TOKEN)).toBe("it-seam");
	});

	it("collapses an empty slug to bare `it` rather than a trailing-dash `it-`", () => {
		const name = stageName("", true, RUN_TOKEN);
		expect(name).toBe("it");
		assertInvariant(name);
	});
});

describe("disc", () => {
	it("is deterministic and DISC_LEN wide in the [a-z0-9] set", () => {
		expect(disc("seed")).toBe(disc("seed"));
		expect(disc("seed")).toHaveLength(DISC_LEN);
		expect(disc("seed")).toMatch(/^[a-z0-9]+$/);
	});
});
