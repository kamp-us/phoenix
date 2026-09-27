/**
 * Whether a `peerDependencies` range admits an installed version — the question an install's
 * unmet-peer warning asks, answered offline from two `package.json` strings.
 *
 * Only the comparator shapes peer ranges in this tree actually use are read: `||` unions of caret,
 * tilde and bare (possibly partial) versions, plus `*`. Anything else is `Unparseable`, never a
 * guess, so a range written in a shape this file does not know fails the caller instead of passing
 * it.
 */
import {compareVersions, parseVersion, type Version} from "./hook/cli-floor.ts";

/** One `>= lower < upper` interval; `upper` is absent only for `*`. */
interface Interval {
	readonly lower: Version;
	readonly upper: Version | undefined;
}

export type PeerRange =
	| {readonly _tag: "Range"; readonly text: string; readonly intervals: ReadonlyArray<Interval>}
	| {readonly _tag: "Unparseable"; readonly text: string; readonly comparator: string};

export type Admission =
	| {readonly _tag: "Admits"}
	| {readonly _tag: "Excludes"; readonly range: string; readonly version: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const PARTIAL = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(0|[1-9]\d*|x|\*))?$/;

const at = (major: number, minor: number, patch: number): Version => ({
	major,
	minor,
	patch,
	prerelease: [],
});

/** `4`, `4.1`, `4.1.5`, `4.x` — how many leading parts were given, and their values. */
const partial = (text: string): {readonly parts: ReadonlyArray<number>} | undefined => {
	const matched = PARTIAL.exec(text);
	if (matched === null) return undefined;
	const parts: number[] = [];
	for (const part of matched.slice(1)) {
		if (part === undefined || part === "x" || part === "*") break;
		parts.push(Number(part));
	}
	return {parts};
};

/** `^`: the leftmost non-zero part given is the one that may not move. */
const caret = (parts: ReadonlyArray<number>): Interval => {
	const [major = 0, minor = 0, patch = 0] = parts;
	const lower = at(major, minor, patch);
	if (major > 0 || parts.length === 1) return {lower, upper: at(major + 1, 0, 0)};
	if (minor > 0 || parts.length === 2) return {lower, upper: at(0, minor + 1, 0)};
	return {lower, upper: at(0, 0, patch + 1)};
};

/** `~`: patch moves when a minor is given, minor moves when only a major is. */
const tilde = (parts: ReadonlyArray<number>): Interval => {
	const [major = 0, minor = 0, patch = 0] = parts;
	const lower = at(major, minor, patch);
	return parts.length === 1
		? {lower, upper: at(major + 1, 0, 0)}
		: {lower, upper: at(major, minor + 1, 0)};
};

/** A bare version: exact when complete, an x-range when partial. */
const bare = (parts: ReadonlyArray<number>): Interval => {
	const [major = 0, minor = 0, patch = 0] = parts;
	const lower = at(major, minor, patch);
	if (parts.length === 1) return {lower, upper: at(major + 1, 0, 0)};
	if (parts.length === 2) return {lower, upper: at(major, minor + 1, 0)};
	return {lower, upper: at(major, minor, patch + 1)};
};

const interval = (comparator: string): Interval | undefined => {
	if (comparator === "*" || comparator === "x") return {lower: at(0, 0, 0), upper: undefined};
	const operator = comparator[0] === "^" || comparator[0] === "~" ? comparator[0] : "";
	const read = partial(comparator.slice(operator.length));
	if (read === undefined || read.parts.length === 0) return undefined;
	if (operator === "^") return caret(read.parts);
	if (operator === "~") return tilde(read.parts);
	return bare(read.parts);
};

export const parsePeerRange = (text: string): PeerRange => {
	const intervals: Interval[] = [];
	for (const comparator of text.split("||").map((part) => part.trim())) {
		const read = interval(comparator);
		if (read === undefined) return {_tag: "Unparseable", text, comparator};
		intervals.push(read);
	}
	return {_tag: "Range", text, intervals};
};

const within = (version: Version, {lower, upper}: Interval): boolean =>
	compareVersions(version, lower) >= 0 &&
	(upper === undefined || compareVersions(version, upper) < 0);

/**
 * The installed version against the declared range. A prerelease is admitted by none of these
 * shapes — npm's rule, since none of them names a prerelease tuple — so it reads `Excludes`.
 */
export const admits = (rangeText: string, versionText: string): Admission => {
	const range = parsePeerRange(rangeText);
	if (range._tag === "Unparseable")
		return {
			_tag: "Unreadable",
			reason: `peer range "${range.text}" has a comparator this reader does not know: "${range.comparator}"`,
		};
	const version = parseVersion(versionText);
	if (version === undefined)
		return {_tag: "Unreadable", reason: `installed version "${versionText}" is not semver`};
	const inside =
		version.prerelease.length === 0 &&
		range.intervals.some((candidate) => within(version, candidate));
	return inside ? {_tag: "Admits"} : {_tag: "Excludes", range: rangeText, version: versionText};
};
