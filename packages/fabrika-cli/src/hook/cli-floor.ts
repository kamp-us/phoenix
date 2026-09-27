/**
 * Whether the running CLI meets the minimum version the fabrika plugin's skills declare.
 *
 * The plugin ships continuously and the CLI ships by release, so an adopter can run skills that call
 * a verb or flag their pinned CLI lacks. The plugin states its minimum in {@link CLI_FLOOR_FILE};
 * this module compares it against the running version and decides between silence and a warning.
 * Every input is a string, so the whole decision is testable without a filesystem.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9675#issuecomment-5790600028
 */

/** The file under the plugin root that carries the minimum. release-please writes its `minimum`. */
export const CLI_FLOOR_FILE = "cli-floor.json";

export const CLI_PACKAGE = "@kampus/fabrika-cli";

export interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	/** Empty for a release. A prerelease ranks below the release it precedes. */
	readonly prerelease: ReadonlyArray<string>;
}

const VERSION_TEXT =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const parseVersion = (text: string): Version | undefined => {
	const matched = VERSION_TEXT.exec(text.trim());
	if (matched === null) return undefined;
	return {
		major: Number(matched[1]),
		minor: Number(matched[2]),
		patch: Number(matched[3]),
		prerelease: matched[4] === undefined ? [] : matched[4].split("."),
	};
};

const NUMERIC = /^\d+$/;

/** semver 2.0.0 §11: numeric identifiers compare as numbers and rank below alphanumeric ones. */
const compareIdentifier = (a: string, b: string): number => {
	const aNumeric = NUMERIC.test(a);
	const bNumeric = NUMERIC.test(b);
	if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
};

/** Negative when `a` precedes `b`, zero when they share a precedence, positive otherwise. */
export const compareVersions = (a: Version, b: Version): number => {
	const core =
		Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
	if (core !== 0) return core;
	if (a.prerelease.length === 0 || b.prerelease.length === 0)
		return Math.sign(b.prerelease.length - a.prerelease.length);
	for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
		const order = compareIdentifier(a.prerelease[i] as string, b.prerelease[i] as string);
		if (order !== 0) return order;
	}
	return Math.sign(a.prerelease.length - b.prerelease.length);
};

/** The floor file's bytes, or why they could not be had. */
export type FloorSource =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export type FloorVerdict =
	| {readonly _tag: "Met"; readonly installed: string; readonly minimum: string}
	| {readonly _tag: "Below"; readonly installed: string; readonly minimum: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

const minimumOf = (
	source: FloorSource,
):
	| {readonly _tag: "Read"; readonly minimum: string}
	| {readonly _tag: "Unknown"; readonly reason: string} => {
	if (source._tag === "Unreadable") return {_tag: "Unknown", reason: source.reason};
	let parsed: unknown;
	try {
		parsed = JSON.parse(source.text);
	} catch (error) {
		return {_tag: "Unknown", reason: `${CLI_FLOOR_FILE} is not JSON (${String(error)})`};
	}
	const minimum =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>).minimum
			: undefined;
	return typeof minimum === "string"
		? {_tag: "Read", minimum}
		: {_tag: "Unknown", reason: `${CLI_FLOOR_FILE} carries no string \`minimum\``};
};

/**
 * Met, below, or UNKNOWN. An unreadable version on either side is UNKNOWN, never a pass: a
 * comparison that could not be made has not shown the CLI is new enough.
 */
export const judgeCliFloor = ({
	installed,
	floor,
}: {
	readonly installed: string;
	readonly floor: FloorSource;
}): FloorVerdict => {
	const running = parseVersion(installed);
	if (running === undefined)
		return {_tag: "Unknown", reason: `the running CLI's version "${installed}" is not semver`};
	const read = minimumOf(floor);
	if (read._tag === "Unknown") return read;
	const minimum = parseVersion(read.minimum);
	if (minimum === undefined)
		return {_tag: "Unknown", reason: `${CLI_FLOOR_FILE}'s minimum "${read.minimum}" is not semver`};
	return compareVersions(running, minimum) < 0
		? {_tag: "Below", installed, minimum: read.minimum}
		: {_tag: "Met", installed, minimum: read.minimum};
};

/** The warning an adopter sees: both versions, what goes wrong, and the upgrade command. */
export const belowFloorWarning = ({
	installed,
	minimum,
}: {
	readonly installed: string;
	readonly minimum: string;
}): string =>
	[
		`fabrika: your ${CLI_PACKAGE} is v${installed}, and the fabrika plugin's skills need v${minimum} or newer.`,
		"A skill may call a verb or flag this CLI does not have, and that fails as a parse error.",
		`Upgrade the repo's copy with \`pnpm add --save-dev ${CLI_PACKAGE}@latest\`, or a global install with \`pnpm add --global ${CLI_PACKAGE}@latest\`.`,
	].join(" ");
