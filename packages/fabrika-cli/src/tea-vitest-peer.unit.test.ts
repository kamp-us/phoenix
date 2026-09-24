/**
 * The `@demlik/tea` this package resolves must admit, through its optional `vitest` peer, the
 * vitest this workspace installs.
 *
 * Tea is a runtime dependency pinned exact, so its peer ranges travel into every adopter's install.
 * 0.12.0 declared `vitest: ^2 || ^3` and every adopter on vitest 4 or 5 got an unmet-peer warning
 * (an `ERESOLVE` crash under npm 11) from a dependency it never chose. This reds the day the
 * workspace's vitest moves past the pinned tea's range, rather than the day an adopter notices.
 *
 * It reads the two installed `package.json` files and nothing else: comparing against npm's
 * `latest` would go red on an upstream publish with no change of ours, and put the network on a
 * gate path.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9771
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A version this guard can compare: a plain release, since a range never admits a prerelease here. */
interface Release {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

/**
 * What a range says about a version. `Unreadable` is its own answer rather than a `false`: a range
 * written in a form this guard does not parse is not proof the version is excluded, and a guard that
 * reads it as excluded reds for the wrong reason while one that reads it as admitted goes blind.
 */
type Verdict =
	| {readonly _tag: "Admits"}
	| {readonly _tag: "Excludes"}
	| {readonly _tag: "Unreadable"; readonly what: string};

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

const release = (version: string): Release | null => {
	const m = RELEASE.exec(version.trim());
	return m === null ? null : {major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3])};
};

const order = (a: Release, b: Release): number =>
	a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * Whether one caret comparator admits `v`, by npm's rule: it allows every change that leaves the
 * left-most non-zero component of the comparator alone — `^4` is `>=4.0.0 <5.0.0`, `^0.2` is
 * `>=0.2.0 <0.3.0`, `^0.0.3` is `>=0.0.3 <0.0.4`.
 */
const caretAdmits = (floor: Release, given: 1 | 2 | 3, v: Release): boolean => {
	if (order(v, floor) < 0) return false;
	if (floor.major > 0 || given === 1) return v.major === floor.major;
	if (floor.minor > 0 || given === 2) return v.major === 0 && v.minor === floor.minor;
	return order(v, floor) === 0;
};

/** Read an `a || b || …` range of caret comparators — the only form tea has ever declared here. */
const admits = (range: string, version: string): Verdict => {
	const v = release(version);
	if (v === null) return {_tag: "Unreadable", what: `version ${JSON.stringify(version)}`};
	let admitted = false;
	for (const clause of range.split("||").map((part) => part.trim())) {
		const m = CARET.exec(clause);
		if (m === null) return {_tag: "Unreadable", what: `range clause ${JSON.stringify(clause)}`};
		const given = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
		const floor = {major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0)};
		admitted ||= caretAdmits(floor, given, v);
	}
	return admitted ? {_tag: "Admits"} : {_tag: "Excludes"};
};

const installed = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(PACKAGE_ROOT, "node_modules", name, "package.json"), "utf8"));

describe("the pinned @demlik/tea's vitest peer admits the installed vitest", () => {
	it("reads the installed tea's range against the installed vitest", () => {
		const tea = installed("@demlik/tea");
		const peers = (tea.peerDependencies ?? {}) as Record<string, string>;
		const range = peers.vitest;
		const vitest = String(installed("vitest").version);

		expect(range, `@demlik/tea@${String(tea.version)} declares no vitest peer`).toBeTypeOf(
			"string",
		);
		expect(
			admits(range ?? "", vitest),
			`@demlik/tea@${String(tea.version)} declares vitest "${range}", which does not admit the installed vitest ${vitest} — every adopter on this vitest gets an unmet-peer warning`,
		).toEqual({_tag: "Admits"});
	});

	it("reds on tea 0.12.0's range against the vitest this workspace installs", () => {
		const vitest = String(installed("vitest").version);
		expect(admits("^2 || ^3", vitest)).toEqual({_tag: "Excludes"});
	});

	it("reads caret ranges by npm's rule", () => {
		expect(admits("^2 || ^3 || ^4 || ^5", "5.0.1")).toEqual({_tag: "Admits"});
		expect(admits("^2 || ^3 || ^4 || ^5", "4.1.11")).toEqual({_tag: "Admits"});
		expect(admits("^2 || ^3", "4.1.11")).toEqual({_tag: "Excludes"});
		expect(admits("^4.2", "4.1.11")).toEqual({_tag: "Excludes"});
		expect(admits("^0.2", "0.2.9")).toEqual({_tag: "Admits"});
		expect(admits("^0.2", "0.3.0")).toEqual({_tag: "Excludes"});
		expect(admits("^0.0.3", "0.0.4")).toEqual({_tag: "Excludes"});
	});

	it("refuses to answer a range or version it cannot read, rather than guessing a polarity", () => {
		expect(admits(">=4 <6", "5.0.1")._tag).toBe("Unreadable");
		expect(admits("^5", "5.0.0-beta.1")._tag).toBe("Unreadable");
	});
});
