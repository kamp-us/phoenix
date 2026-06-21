/**
 * Pins the stage-name invariant of `_stage-name.ts`: `[a-z0-9-]` only, no leading/
 * trailing dash, no internal `--`, non-empty — for every input including the empty/
 * punctuation-only basename that used to emit `it--<disc>` (#698).
 */

import {describe, expect, it} from "vitest";
import {DISC_LEN, disc, nsToken, sharedStageName, slugify, stageName} from "./_stage-name.ts";

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

describe("sharedStageName — run-scoped shared stage (ADR 0104 step 7)", () => {
	it("upholds the stage-name invariant", () => {
		assertInvariant(sharedStageName(RUN_TOKEN));
	});

	it("is the it-shared-<disc> form, seeded on shared|<runToken>", () => {
		expect(sharedStageName(RUN_TOKEN)).toBe(`it-shared-${disc(`shared|${RUN_TOKEN}`)}`);
	});

	it("is run-unique: distinct run tokens yield distinct shared stages", () => {
		expect(sharedStageName("run-a")).not.toBe(sharedStageName("run-b"));
	});
});

describe("nsToken — per-file row namespace on the shared stage (ADR 0104 step 7)", () => {
	it("is stable for a given metaUrl", () => {
		const url = "file:///app/tests/integration/report.test.ts";
		expect(nsToken(url)).toBe(nsToken(url));
	});

	it("strips .test.ts and slugifies the basename", () => {
		expect(nsToken("file:///x/report.test.ts")).toBe("report");
		expect(nsToken("file:///x/pasaport-from-tag.test.ts")).toBe("pasaport-fro");
	});

	it("is distinct for different files", () => {
		expect(nsToken("file:///x/report.test.ts")).not.toBe(
			nsToken("file:///x/pasaport-from-tag.test.ts"),
		);
	});

	it("is bounded to 12 chars and stays in the sanitized [a-z0-9-] set", () => {
		const token = nsToken("file:///x/a-name-far-longer-than-twelve-chars.test.ts");
		expect(token.length).toBeLessThanOrEqual(12);
		expect(token).toMatch(/^[a-z0-9-]+$/);
	});
});

describe("disc", () => {
	it("is deterministic and DISC_LEN wide in the [a-z0-9] set", () => {
		expect(disc("seed")).toBe(disc("seed"));
		expect(disc("seed")).toHaveLength(DISC_LEN);
		expect(disc("seed")).toMatch(/^[a-z0-9]+$/);
	});
});
