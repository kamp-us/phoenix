/**
 * What the palette lists, and what accepting a row types. Pure and DOM-free: the ranking is where a
 * palette is right or wrong, and it is decidable without rendering anything.
 */

import {describe, expect, it} from "vitest";
import {acceptCandidate, paletteCandidates} from "./candidates.ts";
import {registry, snapshot} from "./fixtures.ts";

const labels = (input: string): ReadonlyArray<string> =>
	paletteCandidates(input, registry, snapshot).map((candidate) => candidate.label);

describe("paletteCandidates", () => {
	it("lists the spells under a path prefix, not the bare segment", () => {
		expect(labels("win")).toEqual(["window close", "window move", "window focus"]);
	});

	it("carries each spell's describe", () => {
		const found = paletteCandidates("win", registry, snapshot);
		expect(found.map((candidate) => candidate.describe)).toEqual([
			"Close the focused window.",
			"Move the focused window.",
			"Focus a window by id.",
		]);
		expect(found.every((candidate) => candidate.kind === "spell")).toBe(true);
	});

	it("offers a system name by prefix and never as a subsequence", () => {
		// `wizard-inspect` holds `win` as a subsequence. A spell path is recalled, not searched.
		expect(labels("win")).not.toContain("wizard-inspect");
		expect(labels("wiz")).toEqual(["wizard-inspect"]);
	});

	it("lists every spell of a branch once the branch is named", () => {
		expect(labels("window ")).toEqual(["window close", "window move", "window focus"]);
	});

	it("lists the whole registry on an empty line", () => {
		expect(labels("")).toEqual([
			"window close",
			"window move",
			"window focus",
			"workspace new",
			"workspace activate",
			"help",
			"wizard-inspect",
		]);
	});

	it("ranks a user-named value fuzzily, tightest first", () => {
		// `super-carrier` is listed before `scratch` on the snapshot, so a `scratch`-first answer is
		// the ranking rather than the collection order (#7617 R1.5).
		expect(labels("workspace activate scr")).toEqual(["scratch", "super-carrier"]);
	});

	it("offers an enum parameter's literals by prefix", () => {
		expect(labels("window move l")).toEqual(["left"]);
	});

	it("offers nothing for a segment that prefixes nothing", () => {
		expect(labels("zzz")).toEqual([]);
	});

	it("shows one row per value, though a workspace offers both its name and its id", () => {
		// Every fixture workspace answers to a name and to an id, so a line the caret leaves open lists
		// six values; a name that equals its own id would otherwise be two identical rows.
		const rows = labels("workspace activate ");
		expect(new Set(rows).size).toBe(rows.length);
	});
});

describe("acceptCandidate", () => {
	it("types the whole remaining path from an unfinished segment", () => {
		const [first] = paletteCandidates("win", registry, snapshot);
		expect(first).toBeDefined();
		expect(first === undefined ? "" : acceptCandidate("win", first)).toBe("window close ");
	});

	it("types only the segments the line has not named yet", () => {
		const [first] = paletteCandidates("window cl", registry, snapshot);
		expect(first === undefined ? "" : first.value).toBe("close");
		expect(first === undefined ? "" : acceptCandidate("window cl", first)).toBe("window close ");
	});

	it("replaces the caret's token and leaves the line before it alone", () => {
		const [first] = paletteCandidates("workspace activate scr", registry, snapshot);
		expect(first === undefined ? "" : acceptCandidate("workspace activate scr", first)).toBe(
			"workspace activate scratch ",
		);
	});

	it("appends at the caret when the line ends on a separator", () => {
		const [first] = paletteCandidates("window move ", registry, snapshot);
		expect(first === undefined ? "" : acceptCandidate("window move ", first)).toBe(
			"window move left ",
		);
	});
});
