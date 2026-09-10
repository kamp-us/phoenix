/**
 * The pin on what `portability-guard` may not scan.
 *
 * The self-exempt list is the one place this guard can be widened without any test noticing: a file
 * added to it is a file nothing checks, and it would read in a diff as a two-line edit. So the list
 * is committed as a fixture and compared here, and every entry stays a file suffix — a directory
 * entry would drop every other guard in the group from the scan at once.
 */
import {describe, expect, it} from "vitest";
import {loadGoldenPayload} from "../golden-fixture.ts";
import {isSelfExempt, selfExemptSuffixes} from "./portability.ts";

const FIXTURE = "./__fixtures__/portability-self-exempt.golden.json";

const pinned = (): ReadonlyArray<string> =>
	loadGoldenPayload(import.meta.url, FIXTURE).suffixes as ReadonlyArray<string>;

describe("self-exempt list", () => {
	it("carries exactly the pinned suffixes, in order", () => {
		expect(selfExemptSuffixes()).toEqual(pinned());
	});

	it("names a file every time, never a directory", () => {
		for (const suffix of selfExemptSuffixes()) expect(suffix).toMatch(/\.ts$/);
	});

	it("exempts the pinned files and nothing beside them in the same directory", () => {
		for (const suffix of pinned()) expect(isSelfExempt(`packages/fabrika-cli${suffix}`)).toBe(true);
		expect(isSelfExempt("packages/fabrika-cli/src/guard/no-gh.ts")).toBe(false);
		expect(isSelfExempt("packages/fabrika-cli/src/guard/portability-config.ts")).toBe(false);
	});
});
