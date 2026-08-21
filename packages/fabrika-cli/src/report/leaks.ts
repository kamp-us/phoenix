/**
 * The body-surface leak predicate, shared by `report file`, `report note` and `report amend`.
 *
 * A machine-local path in a body posted to a public issue is a leak, and no merge gate covers it —
 * the repo's committed-file leak gate decides whether a *file in a diff* carries one, and a runtime
 * issue body is never in a diff. This is the ungated surface, not a second verdict on a gated one.
 *
 * **Three generic shapes and no name list.** Every shape is structural, so a new operator, a
 * renamed tool directory or a different machine needs no edit here.
 */

export type LeakClass = "home-relative" | "absolute home root" | "temp root";

export interface Leak {
	/** 1-based line number in the scanned body — what the refusal prints. */
	readonly line: number;
	readonly class: LeakClass;
	readonly text: string;
}

export interface Scan {
	readonly leaks: ReadonlyArray<Leak>;
	/** The body with every match masked to its class root. Equal to the input when there are none. */
	readonly redacted: string;
}

/**
 * The claude CLI's public config leaves these two files, byte-identical on every machine and
 * naming nothing operator-specific. Each carve-out pins the **exact** leaf, so a deeper descent or
 * a longer name still matches.
 */
const CARVE_OUTS = new Set(["~/.claude.json", "~/.claude/settings.json"]);

/** One path segment: anything up to a separator or a character that ends a run in prose/markdown. */
const SEG = String.raw`[^\s\x60'"<>)\]}/]+`;

/**
 * The roots, **longest first** so an overlapping pair cannot corrupt each other: `/private/tmp`
 * must win over `/tmp`, and `/private/var` over a bare `/var`. A single left-to-right pass over
 * this alternation is what gives "longer matches are replaced before shorter ones".
 *
 * Every alternative requires at least one following segment, so the word `/tmp` in prose is not a
 * path and a bare `~` is not a home reference.
 */
const PATH_RE = new RegExp(
	`(?:/private/tmp|/private/var|/var/folders|/tmp|/Users|/home|~)(?:/${SEG})+`,
	"g",
);

/** Trailing sentence punctuation is prose, not part of the path. */
const trimPunctuation = (match: string): string => match.replace(/[.,;:!?]+$/, "");

const ROOTS: ReadonlyArray<{prefix: string; cls: LeakClass; mask: string}> = [
	{prefix: "/private/tmp", cls: "temp root", mask: "/private/tmp/<redacted>"},
	{prefix: "/private/var", cls: "temp root", mask: "/private/var/<redacted>"},
	{prefix: "/var/folders", cls: "temp root", mask: "/var/folders/<redacted>"},
	{prefix: "/tmp", cls: "temp root", mask: "/tmp/<redacted>"},
	{prefix: "/Users", cls: "absolute home root", mask: "/Users/<redacted>"},
	{prefix: "/home", cls: "absolute home root", mask: "/home/<redacted>"},
	{prefix: "~", cls: "home-relative", mask: "~/<redacted>"},
];

const rootOf = (path: string): {cls: LeakClass; mask: string} =>
	ROOTS.find((r) => path.startsWith(r.prefix)) ?? {cls: "temp root", mask: "/tmp/<redacted>"};

/**
 * Scan a body for machine-local paths, and produce the masked body alongside.
 *
 * The mask keeps the class root — `/var/folders/<redacted>`, not one collapsed marker — because
 * *which* root a path came from is itself the evidence. The leaf filename does not survive, and
 * that is deliberate: a filename can identify a person or a machine, and a reader who needs it can
 * ask the reporter.
 */
export const scanBody = (body: string): Scan => {
	const leaks: Leak[] = [];
	const lines = body.split("\n").map((line, index) => {
		PATH_RE.lastIndex = 0;
		return line.replace(PATH_RE, (raw) => {
			const path = trimPunctuation(raw);
			const tail = raw.slice(path.length);
			if (CARVE_OUTS.has(path)) return raw;
			const {cls, mask} = rootOf(path);
			leaks.push({line: index + 1, class: cls, text: path});
			return mask + tail;
		});
	});
	return {leaks, redacted: leaks.length === 0 ? body : lines.join("\n")};
};

/**
 * Whether the body's first non-whitespace run is an `@`-prefixed path.
 *
 * That is the composed body having never arrived at all — #3086's exact byte pattern, where a
 * posting flag that does not expand `@` shipped the literal path into a public artifact and left
 * the description empty. It refuses on its own code because the fix is to send the body, not to
 * mask a placeholder.
 */
export const isBareAtReference = (body: string): boolean => {
	const first = body.trim().split(/\s/)[0] ?? "";
	return first.startsWith("@") && first.includes("/");
};

/** The stderr detail lines a refusal prints under its message: one `line <n>, <class>` per hit. */
export const renderLeaks = (leaks: ReadonlyArray<Leak>): ReadonlyArray<string> =>
	leaks.map((leak) => `  line ${leak.line}, ${leak.class}`);
